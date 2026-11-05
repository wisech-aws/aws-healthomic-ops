# Deployment details

Supplements the [README quick start](../README.md#quick-start).

- [Deploying without deploy.sh](#deploying-without-deploysh)
- [Runtime config for the SPA](#runtime-config-for-the-spa)
- [Sign-in users](#sign-in-users)
- [Cross-account events](#cross-account-events)
- [Replaying from the Kinesis dead letter queue](#replaying-from-the-kinesis-dead-letter-queue)

## Deploying without deploy.sh

`npx cdk deploy` does not build the SPA or the ingest sources, so build them
first:

```bash
npm --prefix ingest run build
npm --prefix frontend run build     # produces frontend/dist
cd infra && npx cdk deploy --all -c kinesisIngestMode=<your mode>   # default mode: off; enrichment default: event
```

The default needs no Kinesis flag. Add `-c kinesisIngestMode=active` to opt
in to the Kinesis buffer, or `-c eventEnrichmentMode=<mode>` to change
enrichment (see [Configuration](../README.md#configuration)). An environment
running Kinesis must pass `-c kinesisIngestMode=active` (or
`scripts/deploy.sh --kinesis-mode active`) on every deploy, or it switches to
`off`.

Build the SPA before every `cdk deploy` that includes `HealthOmicsFrontend`.
If `frontend/dist` is missing, synth prints a `frontend-dist-missing` warning
and the `FrontendStack` skips only the SPA asset upload. The generated
`config.js` deployment, and the cross-stack references to the `HealthOmicsApi`
outputs it uses, are always present, so the `HealthOmicsApi` exports stay the
same and the deploy succeeds; build the SPA and redeploy `HealthOmicsFrontend`
to publish the site. (Before this was fixed, a missing `frontend/dist` made
synth drop the `HealthOmicsApi` exports that a deployed `HealthOmicsFrontend`
imports, and CloudFormation rejected the `HealthOmicsApi` update and rolled it
back.)

## Runtime config for the SPA

The SPA bundle has no environment values baked in. At deploy time the
`FrontendStack` uploads `frontend/dist`, writes a `config.js` that sets
`window.__APP_CONFIG__` from the `ApiStack` outputs, and invalidates the
CloudFront cache. The app reads the config at runtime
(`frontend/src/api/config.ts`), so the same bundle works against any backend.

| ApiStack output | `window.__APP_CONFIG__` field |
|-----------------|-------------------------------|
| `GraphqlApiUrl` | `appsyncEndpoint` |
| `UserPoolId` | `userPoolId` |
| `UserPoolClientId` | `userPoolClientId` |
| `Region` | `region` |

`scripts/inject-config.mjs` can instead write the values into a `.env` file
for build-time injection, which is what local development against a real
backend uses.

## Sign-in users

The user pool has self-signup disabled, so an admin creates every user.
`scripts/create-cognito-user.sh` reads the pool from the stack outputs, checks
the password locally, and sets a permanent password
([options](../scripts/README.md#create-cognito-usersh--create-a-sign-in-user)).

The password policy:

- at least 12 characters,
- lowercase, uppercase, a digit, and a symbol,
- not one of the user's last 3 passwords,
- admin-issued temporary passwords expire after 1 day.

Access and ID tokens last 1 hour; refresh tokens last 30 days. The pool uses
the Cognito Plus feature plan with threat protection enforced, which bills per
monthly active user.

The raw CLI equivalent of the helper:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password \
  --user-pool-id <UserPoolId> --username you@example.com \
  --password '<StrongPassw0rd!>' --permanent
```

## Cross-account events

HealthOmics sends events to the default bus of the account and region where
runs execute. If that is not the dashboard account, forward `aws.omics` events
from the source account's default bus to the dashboard account's default bus
with an EventBridge rule, and allow it with a resource policy on the target
bus. The ingest Lambdas' HealthOmics read permissions are scoped to their own
account, so cross-account enrichment (`GetRun`, `GetRunTask`, `GetWorkflow`)
also needs a role in the source account, which this repo does not set up.

## Replaying from the Kinesis dead letter queue

This applies only with `kinesisIngestMode=active`. On the default direct
path, failed events go to the direct-path dead letter queue (stack output
`DeadLetterQueueUrl`) as the original EventBridge events.

When a Kinesis batch still fails after 5 retries or 1 hour, the event source
mapping sends one message to the Kinesis dead letter queue (stack output
`IngestKinesisDlqUrl`). The message describes the batch (`KinesisBatchInfo`:
shard ID, start and end sequence numbers, batch size), not the events. The
records stay in the stream for 24 hours, so replay within that window:

```bash
aws sqs receive-message --queue-url <IngestKinesisDlqUrl>
aws kinesis get-shard-iterator --stream-name <IngestKinesisStreamName> \
    --shard-id <shardId> --shard-iterator-type AT_SEQUENCE_NUMBER \
    --starting-sequence-number <startSequenceNumber>
aws kinesis get-records --shard-iterator <ShardIterator>
```

Each record's `Data` is a base64-encoded EventBridge event. After fixing the
cause, send the events again, for example with `aws kinesis put-record` using
the run ID as the partition key, or by invoking the direct ingest Lambda with
the decoded event.
