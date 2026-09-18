import * as path from 'path';
import * as fs from 'fs';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  Distribution,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
} from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { ApiStack } from './api-stack';

/** Absolute path to the built SPA assets (frontend/dist). */
const FRONTEND_DIST = path.join(__dirname, '..', '..', 'frontend', 'dist');

export interface FrontendStackProps extends StackProps {
  /** The API whose outputs are injected into the frontend build config. */
  readonly apiStack: ApiStack;
}

/**
 * FrontendStack — the hosting layer.
 *
 * Owns the private S3 bucket (all public access blocked) and the CloudFront
 * distribution using Origin Access Control (OAC), with SPA routing
 * (403/404 -> index.html) so client-side routes resolve.
 *
 * The bucket is served only through CloudFront; there is no public S3 access
 * (Req 11.4). CloudFront maps 403/404 to `/index.html` with HTTP 200 for
 * single-page-application routing (Req 11.5). Resource names and endpoints are
 * exported as stack outputs (Req 11.7). The project identifier tag is applied
 * at the app level in `bin/infra.ts` and inherited by every taggable resource
 * here (Req 11.8).
 *
 * Site assets are built and deployed separately; this stack only provisions the
 * bucket and distribution.
 */
export class FrontendStack extends Stack {
  /** The private S3 bucket holding the built SPA assets. */
  public readonly siteBucket: Bucket;

  /** The CloudFront distribution serving the SPA. */
  public readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    // Private S3 bucket with all public access blocked; it is reachable only
    // through CloudFront via Origin Access Control (Req 11.4). Server-side
    // encryption is enabled. RemovalPolicy.DESTROY + autoDeleteObjects allow a
    // clean `cdk destroy` teardown with no orphaned resources (Req 11.9); this
    // holds only static, rebuildable assets.
    this.siteBucket = new Bucket(this, 'SiteBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront distribution using Origin Access Control (OAC). The S3 bucket
    // is the origin; CDK grants the distribution read access via the bucket
    // policy and blocks all other access (Req 11.4). Requests are redirected to
    // HTTPS. The default root object is index.html.
    //
    // 403/404 responses are mapped to /index.html with HTTP 200 so the SPA's
    // client-side router resolves deep links (Req 11.5).
    this.distribution = new Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.seconds(0),
        },
      ],
    });

    // Stack outputs for downstream tooling and the frontend deploy step
    // (Req 11.7).
    new CfnOutput(this, 'SiteBucketName', {
      value: this.siteBucket.bucketName,
      description: 'Name of the private S3 bucket hosting the SPA assets.',
      exportName: `${this.stackName}-SiteBucketName`,
    });

    new CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'ID of the CloudFront distribution serving the SPA.',
      exportName: `${this.stackName}-DistributionId`,
    });

    new CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'Domain name of the CloudFront distribution serving the SPA.',
      exportName: `${this.stackName}-DistributionDomainName`,
    });

    this.deploySiteAssets(props.apiStack);
  }

  /**
   * Deploy the pre-built SPA assets to the site bucket and inject the deploy-time
   * runtime config, then invalidate CloudFront — so `cdk deploy` publishes a
   * fully working site with no manual `s3 sync` / config-injection step.
   *
   * Two BucketDeployments:
   *   1. The built `frontend/dist` (run `npm run build` in `frontend/` first).
   *   2. A generated `config.js` that sets `window.__APP_CONFIG__` from the
   *      ApiStack outputs (AppSync endpoint, Cognito pool/client, region). The
   *      SPA reads this at runtime (see frontend/src/api/config.ts), so the same
   *      pre-built bundle works against any backend without a rebuild.
   *
   * Both target the same bucket + distribution and invalidate `/*` on deploy.
   * `prune` is disabled on the config deployment so it does not delete the
   * asset deployment's files (and vice-versa: the asset deployment keeps its
   * own prune but must not remove config.js — see note below).
   */
  private deploySiteAssets(apiStack: ApiStack): void {
    // Only wire the asset deployment when the build output exists, so `cdk
    // synth`/`deploy` still works before the frontend has been built (e.g. in
    // CI that builds infra first). When dist is missing we skip asset upload
    // and log guidance rather than failing synth.
    const hasBuild = fs.existsSync(path.join(FRONTEND_DIST, 'index.html'));
    if (!hasBuild) {
      // eslint-disable-next-line no-console
      console.warn(
        `[FrontendStack] ${FRONTEND_DIST} not found — skipping SPA asset ` +
          `deployment. Run \`npm --prefix frontend run build\` before ` +
          `\`cdk deploy\` to publish the site.`,
      );
      return;
    }

    // 1) Runtime config generated from the ApiStack outputs. These are CDK
    //    tokens at synth time; `Fn`-interpolation in the JS string resolves to
    //    the real values in the deployed config.js.
    const configJs = [
      '/* Generated by CDK FrontendStack at deploy time. Do not edit. */',
      'window.__APP_CONFIG__ = {',
      `  appsyncEndpoint: ${JSON.stringify(apiStack.api.graphqlUrl)},`,
      `  userPoolId: ${JSON.stringify(apiStack.userPool.userPoolId)},`,
      `  userPoolClientId: ${JSON.stringify(apiStack.userPoolClient.userPoolClientId)},`,
      `  region: ${JSON.stringify(this.region)},`,
      '};',
      '',
    ].join('\n');

    // 2) Deploy the built SPA. This one prunes (removes stale files) but must
    //    keep config.js, which the config deployment below owns.
    new BucketDeployment(this, 'SiteAssets', {
      sources: [Source.asset(FRONTEND_DIST)],
      destinationBucket: this.siteBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      // Do not delete config.js (owned by the ConfigDeployment) when pruning.
      exclude: ['config.js'],
      prune: false,
    });

    // 3) Deploy the generated runtime config, overwriting the placeholder
    //    config.js baked into the build.
    new BucketDeployment(this, 'SiteConfig', {
      sources: [Source.data('config.js', configJs)],
      destinationBucket: this.siteBucket,
      distribution: this.distribution,
      distributionPaths: ['/config.js'],
      prune: false,
    });
  }
}
