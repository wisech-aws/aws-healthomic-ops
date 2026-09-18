"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FrontendStack = void 0;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_cloudfront_1 = require("aws-cdk-lib/aws-cloudfront");
const aws_cloudfront_origins_1 = require("aws-cdk-lib/aws-cloudfront-origins");
const aws_s3_1 = require("aws-cdk-lib/aws-s3");
const aws_s3_deployment_1 = require("aws-cdk-lib/aws-s3-deployment");
/** Absolute path to the built SPA assets (frontend/dist). */
const FRONTEND_DIST = path.join(__dirname, '..', '..', 'frontend', 'dist');
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
class FrontendStack extends aws_cdk_lib_1.Stack {
    /** The private S3 bucket holding the built SPA assets. */
    siteBucket;
    /** The CloudFront distribution serving the SPA. */
    distribution;
    constructor(scope, id, props) {
        super(scope, id, props);
        // Private S3 bucket with all public access blocked; it is reachable only
        // through CloudFront via Origin Access Control (Req 11.4). Server-side
        // encryption is enabled. RemovalPolicy.DESTROY + autoDeleteObjects allow a
        // clean `cdk destroy` teardown with no orphaned resources (Req 11.9); this
        // holds only static, rebuildable assets.
        this.siteBucket = new aws_s3_1.Bucket(this, 'SiteBucket', {
            blockPublicAccess: aws_s3_1.BlockPublicAccess.BLOCK_ALL,
            encryption: aws_s3_1.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        // CloudFront distribution using Origin Access Control (OAC). The S3 bucket
        // is the origin; CDK grants the distribution read access via the bucket
        // policy and blocks all other access (Req 11.4). Requests are redirected to
        // HTTPS. The default root object is index.html.
        //
        // 403/404 responses are mapped to /index.html with HTTP 200 so the SPA's
        // client-side router resolves deep links (Req 11.5).
        this.distribution = new aws_cloudfront_1.Distribution(this, 'Distribution', {
            defaultRootObject: 'index.html',
            defaultBehavior: {
                origin: aws_cloudfront_origins_1.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
                viewerProtocolPolicy: aws_cloudfront_1.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            },
            errorResponses: [
                {
                    httpStatus: 403,
                    responseHttpStatus: 200,
                    responsePagePath: '/index.html',
                    ttl: aws_cdk_lib_1.Duration.seconds(0),
                },
                {
                    httpStatus: 404,
                    responseHttpStatus: 200,
                    responsePagePath: '/index.html',
                    ttl: aws_cdk_lib_1.Duration.seconds(0),
                },
            ],
        });
        // Stack outputs for downstream tooling and the frontend deploy step
        // (Req 11.7).
        new aws_cdk_lib_1.CfnOutput(this, 'SiteBucketName', {
            value: this.siteBucket.bucketName,
            description: 'Name of the private S3 bucket hosting the SPA assets.',
            exportName: `${this.stackName}-SiteBucketName`,
        });
        new aws_cdk_lib_1.CfnOutput(this, 'DistributionId', {
            value: this.distribution.distributionId,
            description: 'ID of the CloudFront distribution serving the SPA.',
            exportName: `${this.stackName}-DistributionId`,
        });
        new aws_cdk_lib_1.CfnOutput(this, 'DistributionDomainName', {
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
    deploySiteAssets(apiStack) {
        // Only wire the asset deployment when the build output exists, so `cdk
        // synth`/`deploy` still works before the frontend has been built (e.g. in
        // CI that builds infra first). When dist is missing we skip asset upload
        // and log guidance rather than failing synth.
        const hasBuild = fs.existsSync(path.join(FRONTEND_DIST, 'index.html'));
        if (!hasBuild) {
            // eslint-disable-next-line no-console
            console.warn(`[FrontendStack] ${FRONTEND_DIST} not found — skipping SPA asset ` +
                `deployment. Run \`npm --prefix frontend run build\` before ` +
                `\`cdk deploy\` to publish the site.`);
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
        new aws_s3_deployment_1.BucketDeployment(this, 'SiteAssets', {
            sources: [aws_s3_deployment_1.Source.asset(FRONTEND_DIST)],
            destinationBucket: this.siteBucket,
            distribution: this.distribution,
            distributionPaths: ['/*'],
            // Do not delete config.js (owned by the ConfigDeployment) when pruning.
            exclude: ['config.js'],
            prune: false,
        });
        // 3) Deploy the generated runtime config, overwriting the placeholder
        //    config.js baked into the build.
        new aws_s3_deployment_1.BucketDeployment(this, 'SiteConfig', {
            sources: [aws_s3_deployment_1.Source.data('config.js', configJs)],
            destinationBucket: this.siteBucket,
            distribution: this.distribution,
            distributionPaths: ['/config.js'],
            prune: false,
        });
    }
}
exports.FrontendStack = FrontendStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZnJvbnRlbmQtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJmcm9udGVuZC1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSwyQ0FBNkI7QUFDN0IsdUNBQXlCO0FBQ3pCLDZDQUFvRjtBQUNwRiwrREFHb0M7QUFDcEMsK0VBQW9FO0FBQ3BFLCtDQUk0QjtBQUM1QixxRUFBeUU7QUFJekUsNkRBQTZEO0FBQzdELE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsVUFBVSxFQUFFLE1BQU0sQ0FBQyxDQUFDO0FBTzNFOzs7Ozs7Ozs7Ozs7Ozs7O0dBZ0JHO0FBQ0gsTUFBYSxhQUFjLFNBQVEsbUJBQUs7SUFDdEMsMERBQTBEO0lBQzFDLFVBQVUsQ0FBUztJQUVuQyxtREFBbUQ7SUFDbkMsWUFBWSxDQUFlO0lBRTNDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBeUI7UUFDakUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIseUVBQXlFO1FBQ3pFLHVFQUF1RTtRQUN2RSwyRUFBMkU7UUFDM0UsMkVBQTJFO1FBQzNFLHlDQUF5QztRQUN6QyxJQUFJLENBQUMsVUFBVSxHQUFHLElBQUksZUFBTSxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7WUFDL0MsaUJBQWlCLEVBQUUsMEJBQWlCLENBQUMsU0FBUztZQUM5QyxVQUFVLEVBQUUseUJBQWdCLENBQUMsVUFBVTtZQUN2QyxVQUFVLEVBQUUsSUFBSTtZQUNoQixhQUFhLEVBQUUsMkJBQWEsQ0FBQyxPQUFPO1lBQ3BDLGlCQUFpQixFQUFFLElBQUk7U0FDeEIsQ0FBQyxDQUFDO1FBRUgsMkVBQTJFO1FBQzNFLHdFQUF3RTtRQUN4RSw0RUFBNEU7UUFDNUUsZ0RBQWdEO1FBQ2hELEVBQUU7UUFDRix5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Q0osRUFBRTtTQUNILENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBRWIsMEVBQTBFO1FBQzFFLDZEQUE2RDtRQUM3RCxJQUFJLG9DQUFnQixDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7WUFDdkMsT0FBTyxFQUFFLENBQUMsMEJBQU0sQ0FBQyxLQUFLLENBQUMsYUFBYSxDQUFDLENBQUM7WUFDdEMsaUJBQWlCLEVBQUUsSUFBSSxDQUFDLFVBQVU7WUFDbEMsWUFBWSxFQUFFLElBQUksQ0FBQyxZQUFZO1lBQy9CLGlCQUFpQixFQUFFLENBQUMsSUFBSSxDQUFDO1lBQ3pCLHdFQUF3RTtZQUN4RSxPQUFPLEVBQUUsQ0FBQyxXQUFXLENBQUM7WUFDdEIsS0FBSyxFQUFFLEtBQUs7U0FDYixDQUFDLENBQUM7UUFFSCxzRUFBc0U7UUFDdEUscUNBQXFDO1FBQ3JDLElBQUksb0NBQWdCLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUN2QyxPQUFPLEVBQUUsQ0FBQywwQkFBTSxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsUUFBUSxDQUFDLENBQUM7WUFDN0MsaUJBQWlCLEVBQUUsSUFBSSxDQUFDLFVBQVU7WUFDbEMsWUFBWSxFQUFFLElBQUksQ0FBQyxZQUFZO1lBQy9CLGlCQUFpQixFQUFFLENBQUMsWUFBWSxDQUFDO1lBQ2pDLEtBQUssRUFBRSxLQUFLO1NBQ2IsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBaEpELHNDQWdKQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcyc7XG5pbXBvcnQgeyBDZm5PdXRwdXQsIER1cmF0aW9uLCBSZW1vdmFsUG9saWN5LCBTdGFjaywgU3RhY2tQcm9wcyB9IGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7XG4gIERpc3RyaWJ1dGlvbixcbiAgVmlld2VyUHJvdG9jb2xQb2xpY3ksXG59IGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZGZyb250JztcbmltcG9ydCB7IFMzQnVja2V0T3JpZ2luIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2lucyc7XG5pbXBvcnQge1xuICBCbG9ja1B1YmxpY0FjY2VzcyxcbiAgQnVja2V0LFxuICBCdWNrZXRFbmNyeXB0aW9uLFxufSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0IHsgQnVja2V0RGVwbG95bWVudCwgU291cmNlIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzLWRlcGxveW1lbnQnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBBcGlTdGFjayB9IGZyb20gJy4vYXBpLXN0YWNrJztcblxuLyoqIEFic29sdXRlIHBhdGggdG8gdGhlIGJ1aWx0IFNQQSBhc3NldHMgKGZyb250ZW5kL2Rpc3QpLiAqL1xuY29uc3QgRlJPTlRFTkRfRElTVCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICcuLicsICdmcm9udGVuZCcsICdkaXN0Jyk7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRnJvbnRlbmRTdGFja1Byb3BzIGV4dGVuZHMgU3RhY2tQcm9wcyB7XG4gIC8qKiBUaGUgQVBJIHdob3NlIG91dHB1dHMgYXJlIGluamVjdGVkIGludG8gdGhlIGZyb250ZW5kIGJ1aWxkIGNvbmZpZy4gKi9cbiAgcmVhZG9ubHkgYXBpU3RhY2s6IEFwaVN0YWNrO1xufVxuXG4vKipcbiAqIEZyb250ZW5kU3RhY2sg4oCUIHRoZSBob3N0aW5nIGxheWVyLlxuICpcbiAqIE93bnMgdGhlIHByaXZhdGUgUzMgYnVja2V0IChhbGwgcHVibGljIGFjY2VzcyBibG9ja2VkKSBhbmQgdGhlIENsb3VkRnJvbnRcbiAqIGRpc3RyaWJ1dGlvbiB1c2luZyBPcmlnaW4gQWNjZXNzIENvbnRyb2wgKE9BQyksIHdpdGggU1BBIHJvdXRpbmdcbiAqICg0MDMvNDA0IC0+IGluZGV4Lmh0bWwpIHNvIGNsaWVudC1zaWRlIHJvdXRlcyByZXNvbHZlLlxuICpcbiAqIFRoZSBidWNrZXQgaXMgc2VydmVkIG9ubHkgdGhyb3VnaCBDbG91ZEZyb250OyB0aGVyZSBpcyBubyBwdWJsaWMgUzMgYWNjZXNzXG4gKiAoUmVxIDExLjQpLiBDbG91ZEZyb250IG1hcHMgNDAzLzQwNCB0byBgL2luZGV4Lmh0bWxgIHdpdGggSFRUUCAyMDAgZm9yXG4gKiBzaW5nbGUtcGFnZS1hcHBsaWNhdGlvbiByb3V0aW5nIChSZXEgMTEuNSkuIFJlc291cmNlIG5hbWVzIGFuZCBlbmRwb2ludHMgYXJlXG4gKiBleHBvcnRlZCBhcyBzdGFjayBvdXRwdXRzIChSZXEgMTEuNykuIFRoZSBwcm9qZWN0IGlkZW50aWZpZXIgdGFnIGlzIGFwcGxpZWRcbiAqIGF0IHRoZSBhcHAgbGV2ZWwgaW4gYGJpbi9pbmZyYS50c2AgYW5kIGluaGVyaXRlZCBieSBldmVyeSB0YWdnYWJsZSByZXNvdXJjZVxuICogaGVyZSAoUmVxIDExLjgpLlxuICpcbiAqIFNpdGUgYXNzZXRzIGFyZSBidWlsdCBhbmQgZGVwbG95ZWQgc2VwYXJhdGVseTsgdGhpcyBzdGFjayBvbmx5IHByb3Zpc2lvbnMgdGhlXG4gKiBidWNrZXQgYW5kIGRpc3RyaWJ1dGlvbi5cbiAqL1xuZXhwb3J0IGNsYXNzIEZyb250ZW5kU3RhY2sgZXh0ZW5kcyBTdGFjayB7XG4gIC8qKiBUaGUgcHJpdmF0ZSBTMyBidWNrZXQgaG9sZGluZyB0aGUgYnVpbHQgU1BBIGFzc2V0cy4gKi9cbiAgcHVibGljIHJlYWRvbmx5IHNpdGVCdWNrZXQ6IEJ1Y2tldDtcblxuICAvKiogVGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uIHNlcnZpbmcgdGhlIFNQQS4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGRpc3RyaWJ1dGlvbjogRGlzdHJpYnV0aW9uO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBGcm9udGVuZFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIFByaXZhdGUgUzMgYnVja2V0IHdpdGggYWxsIHB1YmxpYyBhY2Nlc3MgYmxvY2tlZDsgaXQgaXMgcmVhY2hhYmxlIG9ubHlcbiAgICAvLyB0aHJvdWdoIENsb3VkRnJvbnQgdmlhIE9yaWdpbiBBY2Nlc3MgQ29udHJvbCAoUmVxIDExLjQpLiBTZXJ2ZXItc2lkZVxuICAgIC8vIGVuY3J5cHRpb24gaXMgZW5hYmxlZC4gUmVtb3ZhbFBvbGljeS5ERVNUUk9ZICsgYXV0b0RlbGV0ZU9iamVjdHMgYWxsb3cgYVxuICAgIC8vIGNsZWFuIGBjZGsgZGVzdHJveWAgdGVhcmRvd24gd2l0aCBubyBvcnBoYW5lZCByZXNvdXJjZXMgKFJlcSAxMS45KTsgdGhpc1xuICAgIC8vIGhvbGRzIG9ubHkgc3RhdGljLCByZWJ1aWxkYWJsZSBhc3NldHMuXG4gICAgdGhpcy5zaXRlQnVja2V0ID0gbmV3IEJ1Y2tldCh0aGlzLCAnU2l0ZUJ1Y2tldCcsIHtcbiAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBCbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICBlbmNyeXB0aW9uOiBCdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiB1c2luZyBPcmlnaW4gQWNjZXNzIENvbnRyb2wgKE9BQykuIFRoZSBTMyBidWNrZXRcbiAgICAvLyBpcyB0aGUgb3JpZ2luOyBDREsgZ3JhbnRzIHRoZSBkaXN0cmlidXRpb24gcmVhZCBhY2Nlc3MgdmlhIHRoZSBidWNrZXRcbiAgICAvLyBwb2xpY3kgYW5kIGJsb2NrcyBhbGwgb3RoZXIgYWNjZXNzIChSZXEgMTEuNCkuIFJlcXVlc3RzIGFyZSByZWRpcmVjdGVkIHRvXG4gICAgLy8gSFRUUFMuIFRoZSBkZWZhdWx0IHJvb3Qgb2JqZWN0IGlzIGluZGV4Lmh0bWwuXG4gICAgLy9cbiAgICAvLyA0MDMvNDA0IHJlc3BvbnNlcyBhcmUgbWFwcGVkIHRvIC9pbmRleC5odG1sIHdpdGggSFRUUCAyMDAgc28gdGhlIFNQQSdzXG4gICAgLy8gY2xpZW50LXNpZGUgcm91dGVyIHJlc29sdmVzIGRlZXAgbGlua3MgKFJlcSAxMS41KS5cbiAgICB0aGlzLmRpc3RyaWJ1dGlvbiA9IG5ldyBEaXN0cmlidXRpb24odGhpcywgJ0Rpc3RyaWJ1dGlvbicsIHtcbiAgICAgIGRlZmF1bHRSb290T2JqZWN0OiAnaW5kZXguaHRtbCcsXG4gICAgICBkZWZhdWx0QmVoYXZpb3I6IHtcbiAgICAgICAgb3JpZ2luOiBTM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbCh0aGlzLnNpdGVCdWNrZXQpLFxuICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICB9LFxuICAgICAgZXJyb3JSZXNwb25zZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGh0dHBTdGF0dXM6IDQwMyxcbiAgICAgICAgICByZXNwb25zZUh0dHBTdGF0dXM6IDIwMCxcbiAgICAgICAgICByZXNwb25zZVBhZ2VQYXRoOiAnL2luZGV4Lmh0bWwnLFxuICAgICAgICAgIHR0bDogRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGh0dHBTdGF0dXM6IDQwNCxcbiAgICAgICAgICByZXNwb25zZUh0dHBTdGF0dXM6IDIwMCxcbiAgICAgICAgICByZXNwb25zZVBhZ2VQYXRoOiAnL2luZGV4Lmh0bWwnLFxuICAgICAgICAgIHR0bDogRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICAvLyBTdGFjayBvdXRwdXRzIGZvciBkb3duc3RyZWFtIHRvb2xpbmcgYW5kIHRoZSBmcm9udGVuZCBkZXBsb3kgc3RlcFxuICAgIC8vIChSZXEgMTEuNykuXG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCAnU2l0ZUJ1Y2tldE5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5zaXRlQnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ05hbWUgb2YgdGhlIHByaXZhdGUgUzMgYnVja2V0IGhvc3RpbmcgdGhlIFNQQSBhc3NldHMuJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1TaXRlQnVja2V0TmFtZWAsXG4gICAgfSk7XG5cbiAgICBuZXcgQ2ZuT3V0cHV0KHRoaXMsICdEaXN0cmlidXRpb25JZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25JZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnSUQgb2YgdGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uIHNlcnZpbmcgdGhlIFNQQS4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LURpc3RyaWJ1dGlvbklkYCxcbiAgICB9KTtcblxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ0Rpc3RyaWJ1dGlvbkRvbWFpbk5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5kaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uRG9tYWluTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRG9tYWluIG5hbWUgb2YgdGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uIHNlcnZpbmcgdGhlIFNQQS4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LURpc3RyaWJ1dGlvbkRvbWFpbk5hbWVgLFxuICAgIH0pO1xuXG4gICAgdGhpcy5kZXBsb3lTaXRlQXNzZXRzKHByb3BzLmFwaVN0YWNrKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBEZXBsb3kgdGhlIHByZS1idWlsdCBTUEEgYXNzZXRzIHRvIHRoZSBzaXRlIGJ1Y2tldCBhbmQgaW5qZWN0IHRoZSBkZXBsb3ktdGltZVxuICAgKiBydW50aW1lIGNvbmZpZywgdGhlbiBpbnZhbGlkYXRlIENsb3VkRnJvbnQg4oCUIHNvIGBjZGsgZGVwbG95YCBwdWJsaXNoZXMgYVxuICAgKiBmdWxseSB3b3JraW5nIHNpdGUgd2l0aCBubyBtYW51YWwgYHMzIHN5bmNgIC8gY29uZmlnLWluamVjdGlvbiBzdGVwLlxuICAgKlxuICAgKiBUd28gQnVja2V0RGVwbG95bWVudHM6XG4gICAqICAgMS4gVGhlIGJ1aWx0IGBmcm9udGVuZC9kaXN0YCAocnVuIGBucG0gcnVuIGJ1aWxkYCBpbiBgZnJvbnRlbmQvYCBmaXJzdCkuXG4gICAqICAgMi4gQSBnZW5lcmF0ZWQgYGNvbmZpZy5qc2AgdGhhdCBzZXRzIGB3aW5kb3cuX19BUFBfQ09ORklHX19gIGZyb20gdGhlXG4gICAqICAgICAgQXBpU3RhY2sgb3V0cHV0cyAoQXBwU3luYyBlbmRwb2ludCwgQ29nbml0byBwb29sL2NsaWVudCwgcmVnaW9uKS4gVGhlXG4gICAqICAgICAgU1BBIHJlYWRzIHRoaXMgYXQgcnVudGltZSAoc2VlIGZyb250ZW5kL3NyYy9hcGkvY29uZmlnLnRzKSwgc28gdGhlIHNhbWVcbiAgICogICAgICBwcmUtYnVpbHQgYnVuZGxlIHdvcmtzIGFnYWluc3QgYW55IGJhY2tlbmQgd2l0aG91dCBhIHJlYnVpbGQuXG4gICAqXG4gICAqIEJvdGggdGFyZ2V0IHRoZSBzYW1lIGJ1Y2tldCArIGRpc3RyaWJ1dGlvbiBhbmQgaW52YWxpZGF0ZSBgLypgIG9uIGRlcGxveS5cbiAgICogYHBydW5lYCBpcyBkaXNhYmxlZCBvbiB0aGUgY29uZmlnIGRlcGxveW1lbnQgc28gaXQgZG9lcyBub3QgZGVsZXRlIHRoZVxuICAgKiBhc3NldCBkZXBsb3ltZW50J3MgZmlsZXMgKGFuZCB2aWNlLXZlcnNhOiB0aGUgYXNzZXQgZGVwbG95bWVudCBrZWVwcyBpdHNcbiAgICogb3duIHBydW5lIGJ1dCBtdXN0IG5vdCByZW1vdmUgY29uZmlnLmpzIOKAlCBzZWUgbm90ZSBiZWxvdykuXG4gICAqL1xuICBwcml2YXRlIGRlcGxveVNpdGVBc3NldHMoYXBpU3RhY2s6IEFwaVN0YWNrKTogdm9pZCB7XG4gICAgLy8gT25seSB3aXJlIHRoZSBhc3NldCBkZXBsb3ltZW50IHdoZW4gdGhlIGJ1aWxkIG91dHB1dCBleGlzdHMsIHNvIGBjZGtcbiAgICAvLyBzeW50aGAvYGRlcGxveWAgc3RpbGwgd29ya3MgYmVmb3JlIHRoZSBmcm9udGVuZCBoYXMgYmVlbiBidWlsdCAoZS5nLiBpblxuICAgIC8vIENJIHRoYXQgYnVpbGRzIGluZnJhIGZpcnN0KS4gV2hlbiBkaXN0IGlzIG1pc3Npbmcgd2Ugc2tpcCBhc3NldCB1cGxvYWRcbiAgICAvLyBhbmQgbG9nIGd1aWRhbmNlIHJhdGhlciB0aGFuIGZhaWxpbmcgc3ludGguXG4gICAgY29uc3QgaGFzQnVpbGQgPSBmcy5leGlzdHNTeW5jKHBhdGguam9pbihGUk9OVEVORF9ESVNULCAnaW5kZXguaHRtbCcpKTtcbiAgICBpZiAoIWhhc0J1aWxkKSB7XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICBgW0Zyb250ZW5kU3RhY2tdICR7RlJPTlRFTkRfRElTVH0gbm90IGZvdW5kIOKAlCBza2lwcGluZyBTUEEgYXNzZXQgYCArXG4gICAgICAgICAgYGRlcGxveW1lbnQuIFJ1biBcXGBucG0gLS1wcmVmaXggZnJvbnRlbmQgcnVuIGJ1aWxkXFxgIGJlZm9yZSBgICtcbiAgICAgICAgICBgXFxgY2RrIGRlcGxveVxcYCB0byBwdWJsaXNoIHRoZSBzaXRlLmAsXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIDEpIFJ1bnRpbWUgY29uZmlnIGdlbmVyYXRlZCBmcm9tIHRoZSBBcGlTdGFjayBvdXRwdXRzLiBUaGVzZSBhcmUgQ0RLXG4gICAgLy8gICAgdG9rZW5zIGF0IHN5bnRoIHRpbWU7IGBGbmAtaW50ZXJwb2xhdGlvbiBpbiB0aGUgSlMgc3RyaW5nIHJlc29sdmVzIHRvXG4gICAgLy8gICAgdGhlIHJlYWwgdmFsdWVzIGluIHRoZSBkZXBsb3llZCBjb25maWcuanMuXG4gICAgY29uc3QgY29uZmlnSnMgPSBbXG4gICAgICAnLyogR2VuZXJhdGVkIGJ5IENESyBGcm9udGVuZFN0YWNrIGF0IGRlcGxveSB0aW1lLiBEbyBub3QgZWRpdC4gKi8nLFxuICAgICAgJ3dpbmRvdy5fX0FQUF9DT05GSUdfXyA9IHsnLFxuICAgICAgYCAgYXBwc3luY0VuZHBvaW50OiAke0pTT04uc3RyaW5naWZ5KGFwaVN0YWNrLmFwaS5ncmFwaHFsVXJsKX0sYCxcbiAgICAgIGAgIHVzZXJQb29sSWQ6ICR7SlNPTi5zdHJpbmdpZnkoYXBpU3RhY2sudXNlclBvb2wudXNlclBvb2xJZCl9LGAsXG4gICAgICBgICB1c2VyUG9vbENsaWVudElkOiAke0pTT04uc3RyaW5naWZ5KGFwaVN0YWNrLnVzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQpfSxgLFxuICAgICAgYCAgcmVnaW9uOiAke0pTT04uc3RyaW5naWZ5KHRoaXMucmVnaW9uKX0sYCxcbiAgICAgICd9OycsXG4gICAgICAnJyxcbiAgICBdLmpvaW4oJ1xcbicpO1xuXG4gICAgLy8gMikgRGVwbG95IHRoZSBidWlsdCBTUEEuIFRoaXMgb25lIHBydW5lcyAocmVtb3ZlcyBzdGFsZSBmaWxlcykgYnV0IG11c3RcbiAgICAvLyAgICBrZWVwIGNvbmZpZy5qcywgd2hpY2ggdGhlIGNvbmZpZyBkZXBsb3ltZW50IGJlbG93IG93bnMuXG4gICAgbmV3IEJ1Y2tldERlcGxveW1lbnQodGhpcywgJ1NpdGVBc3NldHMnLCB7XG4gICAgICBzb3VyY2VzOiBbU291cmNlLmFzc2V0KEZST05URU5EX0RJU1QpXSxcbiAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiB0aGlzLnNpdGVCdWNrZXQsXG4gICAgICBkaXN0cmlidXRpb246IHRoaXMuZGlzdHJpYnV0aW9uLFxuICAgICAgZGlzdHJpYnV0aW9uUGF0aHM6IFsnLyonXSxcbiAgICAgIC8vIERvIG5vdCBkZWxldGUgY29uZmlnLmpzIChvd25lZCBieSB0aGUgQ29uZmlnRGVwbG95bWVudCkgd2hlbiBwcnVuaW5nLlxuICAgICAgZXhjbHVkZTogWydjb25maWcuanMnXSxcbiAgICAgIHBydW5lOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIC8vIDMpIERlcGxveSB0aGUgZ2VuZXJhdGVkIHJ1bnRpbWUgY29uZmlnLCBvdmVyd3JpdGluZyB0aGUgcGxhY2Vob2xkZXJcbiAgICAvLyAgICBjb25maWcuanMgYmFrZWQgaW50byB0aGUgYnVpbGQuXG4gICAgbmV3IEJ1Y2tldERlcGxveW1lbnQodGhpcywgJ1NpdGVDb25maWcnLCB7XG4gICAgICBzb3VyY2VzOiBbU291cmNlLmRhdGEoJ2NvbmZpZy5qcycsIGNvbmZpZ0pzKV0sXG4gICAgICBkZXN0aW5hdGlvbkJ1Y2tldDogdGhpcy5zaXRlQnVja2V0LFxuICAgICAgZGlzdHJpYnV0aW9uOiB0aGlzLmRpc3RyaWJ1dGlvbixcbiAgICAgIGRpc3RyaWJ1dGlvblBhdGhzOiBbJy9jb25maWcuanMnXSxcbiAgICAgIHBydW5lOiBmYWxzZSxcbiAgICB9KTtcbiAgfVxufVxuIl19