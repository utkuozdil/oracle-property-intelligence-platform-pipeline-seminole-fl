import * as path from 'node:path';
import { SERVICE_NAME, type TargetEnv } from '@oracle-seminole/shared';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';
import { TRPC_ROUTE_PREFIX } from './api-stack';

export interface WebStackProps extends cdk.StackProps {
  targetEnv: TargetEnv;
  /** Directory holding the built SPA. Must exist at synth time. */
  siteDistPath: string;
  /** `execute-api` host of the tRPC HTTP API, used as the CloudFront API origin. */
  apiOriginDomain: string;
}

/**
 * Static hosting for the Oracle UI: a private S3 bucket behind CloudFront with Origin
 * Access Control.
 *
 * The same distribution also fronts the tRPC HTTP API under `/trpc/*`. That gives the
 * SPA a same-origin API — no CORS preflight, no build-time API URL to inject, and one
 * public HTTPS hostname for the whole application.
 */
export class WebStack extends cdk.Stack {
  readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    /**
     * Rewrites SPA routes to `/index.html`. This is attached only to the static
     * behaviour — using CloudFront `errorResponses` instead would also rewrite genuine
     * 403/404 responses coming back from the API origin.
     */
    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      comment: 'Rewrite extensionless SPA routes to /index.html',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (!uri.split('/').pop().includes('.')) {
    request.uri = '/index.html';
  }
  return request;
}
`),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${SERVICE_NAME} ${props.targetEnv} web + API`,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: spaRewrite,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      /**
       * Second line of SPA defence, and the only one that covers requests the viewer
       * function deliberately leaves alone: a path that looks like an asset
       * (`/app.v2.js`) but is absent from the bucket, which OAC answers with 403.
       *
       * Custom error responses are distribution-wide, so these are scoped to the two
       * S3 "missing key" statuses only. A tRPC 4xx uses neither, so API error bodies
       * still reach the browser intact.
       */
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      additionalBehaviors: {
        [`${TRPC_ROUTE_PREFIX}/*`]: {
          origin: new origins.HttpOrigin(props.apiOriginDomain, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    new s3deploy.BucketDeployment(this, 'SiteDeployment', {
      sources: [s3deploy.Source.asset(path.resolve(props.siteDistPath))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true,
    });

    this.distributionDomainName = distribution.distributionDomainName;

    new cdk.CfnOutput(this, 'SiteUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Public HTTPS entry point for the Oracle UI and its tRPC API',
    });
    new cdk.CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
  }
}
