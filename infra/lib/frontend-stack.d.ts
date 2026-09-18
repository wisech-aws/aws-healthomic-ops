import { Stack, StackProps } from 'aws-cdk-lib';
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { ApiStack } from './api-stack';
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
export declare class FrontendStack extends Stack {
    /** The private S3 bucket holding the built SPA assets. */
    readonly siteBucket: Bucket;
    /** The CloudFront distribution serving the SPA. */
    readonly distribution: Distribution;
    constructor(scope: Construct, id: string, props: FrontendStackProps);
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
    private deploySiteAssets;
}
