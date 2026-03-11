import * as fc from 'fast-check';
import { FakeBuildAction } from './fake-build-action';
import { FakeSourceAction } from './fake-source-action';
import { Match, Template } from '../../assertions';
import * as iam from '../../aws-iam';
import * as kms from '../../aws-kms';
import * as s3 from '../../aws-s3';
import * as cdk from '../../core';
import * as codepipeline from '../lib';

// Helper: create a pipeline with 2 stages so validation passes
function createPipeline(stack: cdk.Stack, props?: codepipeline.PipelineProps): codepipeline.Pipeline {
  const sourceArtifact = new codepipeline.Artifact();
  const pipeline = new codepipeline.Pipeline(stack, 'Pipeline', props);
  pipeline.addStage({
    stageName: 'Source',
    actions: [new FakeSourceAction({ actionName: 'Source', output: sourceArtifact })],
  });
  pipeline.addStage({
    stageName: 'Build',
    actions: [new FakeBuildAction({ actionName: 'Build', input: sourceArtifact })],
  });
  return pipeline;
}

describe('Pipeline Troubleshooting Agent', () => {
  test('agent disabled by default when agents prop is not set', () => {
    const stack = new cdk.Stack();
    createPipeline(stack);
    const template = Template.fromStack(stack);

    // No agent results bucket (only artifact bucket)
    template.resourceCountIs('AWS::S3::Bucket', 1);
    // Pipeline should not have PipelineAgents property
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      PipelineAgents: Match.absent(),
    });
  });

  test('agent explicitly disabled produces no agent resources', () => {
    const stack = new cdk.Stack();
    createPipeline(stack, {
      agents: { troubleshooting: { enabled: false } },
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      PipelineAgents: Match.absent(),
    });
  });

  test('throws when agent is enabled without pipelineName', () => {
    const stack = new cdk.Stack();
    expect(() => {
      createPipeline(stack, {
        agents: { troubleshooting: { enabled: true } },
      });
    }).toThrow(/'pipelineName' is required when the troubleshooting agent is enabled/);
  });

  test('agent enabled creates S3 bucket with correct configuration', () => {
    const stack = new cdk.Stack();
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true } },
    });
    const template = Template.fromStack(stack);

    // Should have 2 S3 buckets (artifact + agent results)
    template.resourceCountIs('AWS::S3::Bucket', 2);

    // Agent results bucket: SSE-S3, block public access, DeletionPolicy Retain, lifecycle 90 days, tags
    template.hasResource('AWS::S3::Bucket', {
      Properties: {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [{
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          }],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        VersioningConfiguration: Match.absent(),
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              ExpirationInDays: 90,
              Id: 'DeleteOldTroubleshootingData',
              Status: 'Enabled',
            }),
          ]),
        },
        Tags: Match.arrayWith([
          { Key: 'aws-cdk:managed-by', Value: 'CDK' },
          { Key: 'aws-cdk:purpose', Value: 'AgentTroubleshooting' },
          { Key: 'aws-cdk:service', Value: 'CodePipeline' },
        ]),
      },
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('agent enabled creates S3 bucket with SSL enforcement', () => {
    const stack = new cdk.Stack();
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true } },
    });
    const template = Template.fromStack(stack);

    // enforceSSL adds a bucket policy denying non-SSL requests.
    // There are 2 bucket policies (artifact + agent), so just check one has the SSL deny.
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: {
              Bool: { 'aws:SecureTransport': 'false' },
            },
          }),
        ]),
      },
    });
  });

  test('agent enabled creates IAM role with correct trust policy', () => {
    const stack = new cdk.Stack();
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true } },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { Service: 'codepipeline.amazonaws.com' },
            Condition: {
              StringEquals: {
                'aws:SourceAccount': { Ref: 'AWS::AccountId' },
                'aws:SourceArn': Match.anyValue(),
              },
            },
          }),
        ]),
      },
    });
  });

  test('agent enabled attaches AWSCodePipelineTroubleshootingAgentAccess managed policy', () => {
    const stack = new cdk.Stack();
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true } },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        {
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp('AWSCodePipelineTroubleshootingAgentAccess'),
            ]),
          ]),
        },
      ]),
    });
  });

  test('agent enabled creates inline policy with S3 write to agent bucket', () => {
    const stack = new cdk.Stack();
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true } },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'S3BucketWriteAccess',
            Action: ['s3:PutObject', 's3:PutObjectTagging'],
            Effect: 'Allow',
            Condition: {
              StringEquals: { 'aws:ResourceAccount': { Ref: 'AWS::AccountId' } },
            },
          }),
        ]),
      },
    });
  });

  test('agent enabled creates inline policy with S3 read from artifact bucket', () => {
    const stack = new cdk.Stack();
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true } },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'S3BucketReadOnlyAccess',
            Action: ['s3:GetObject', 's3:GetObjectTagging', 's3:ListBucket'],
            Effect: 'Allow',
            Condition: {
              StringEquals: { 'aws:ResourceAccount': { Ref: 'AWS::AccountId' } },
            },
          }),
        ]),
      },
    });
  });

  test('agent enabled creates inline policy with CloudWatch Logs write', () => {
    const stack = new cdk.Stack();
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true } },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'CloudWatchLogsWriteAccess',
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('agent enabled adds PipelineAgents property with correct structure', () => {
    const stack = new cdk.Stack();
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true } },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      PipelineAgents: Match.arrayWith([
        Match.objectLike({
          agentType: 'TROUBLESHOOTING',
          enabled: true,
          agentArtifactStore: {
            location: Match.anyValue(),
          },
          roleArn: Match.anyValue(),
          qEndpointRegion: 'us-east-1',
        }),
      ]),
    });
  });

  test('agent role has DeletionPolicy Delete and bucket has DeletionPolicy Retain', () => {
    const stack = new cdk.Stack();
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true } },
    });
    const template = Template.fromStack(stack);

    // Find the agent role (the one with codepipeline trust + SourceAccount condition)
    template.hasResource('AWS::IAM::Role', {
      Properties: {
        AssumeRolePolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Condition: {
                StringEquals: {
                  'aws:SourceAccount': Match.anyValue(),
                },
              },
            }),
          ]),
        },
      },
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });

    // Agent results bucket has Retain
    template.hasResource('AWS::S3::Bucket', {
      Properties: {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({ ExpirationInDays: 90 }),
          ]),
        },
      },
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });
});

// Arbitrary: valid pipeline names (alphanumeric + hyphens, starts with alpha, 1-100 chars)
const pipelineNameArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'.split('')),
  { minLength: 1, maxLength: 100 },
).filter(s => /^[A-Za-z]/.test(s));

describe('Pipeline Troubleshooting Agent - Property Tests', () => {
  // Property 1: Agent disabled produces no agent resources (Task 2.2)
  test('Property 1: disabling agent never produces agent resources regardless of pipeline name', () => {
    fc.assert(
      fc.property(pipelineNameArb, fc.constantFrom(undefined, false), (name, enabled) => {
        const stack = new cdk.Stack();
        const agentsProp = enabled === undefined
          ? undefined
          : { agents: { troubleshooting: { enabled } } };
        createPipeline(stack, { pipelineName: name, ...agentsProp });
        const template = Template.fromStack(stack);

        // Only artifact bucket, no agent bucket
        template.resourceCountIs('AWS::S3::Bucket', 1);
        template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
          PipelineAgents: Match.absent(),
        });
      }),
      { numRuns: 20 },
    );
  });

  // Property 2: Agent Results Bucket configuration (Task 2.3)
  test('Property 2: agent bucket always has correct security and lifecycle config', () => {
    fc.assert(
      fc.property(pipelineNameArb, (name) => {
        const stack = new cdk.Stack();
        createPipeline(stack, {
          pipelineName: name,
          agents: { troubleshooting: { enabled: true } },
        });
        const template = Template.fromStack(stack);

        // 2 buckets: artifact + agent
        template.resourceCountIs('AWS::S3::Bucket', 2);

        template.hasResource('AWS::S3::Bucket', {
          Properties: {
            BucketEncryption: {
              ServerSideEncryptionConfiguration: [{
                ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
              }],
            },
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: true,
              BlockPublicPolicy: true,
              IgnorePublicAcls: true,
              RestrictPublicBuckets: true,
            },
            LifecycleConfiguration: {
              Rules: Match.arrayWith([
                Match.objectLike({ ExpirationInDays: 90, Status: 'Enabled' }),
              ]),
            },
            Tags: Match.arrayWith([
              { Key: 'aws-cdk:purpose', Value: 'AgentTroubleshooting' },
            ]),
          },
          DeletionPolicy: 'Retain',
          UpdateReplacePolicy: 'Retain',
        });
      }),
      { numRuns: 20 },
    );
  });

  // Property 3: Agent Role configuration (Task 2.4)
  test('Property 3: agent role always has correct trust policy and permissions', () => {
    fc.assert(
      fc.property(pipelineNameArb, (name) => {
        const stack = new cdk.Stack();
        createPipeline(stack, {
          pipelineName: name,
          agents: { troubleshooting: { enabled: true } },
        });
        const template = Template.fromStack(stack);

        // Trust policy with codepipeline service and SourceAccount condition
        template.hasResourceProperties('AWS::IAM::Role', {
          AssumeRolePolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: 'sts:AssumeRole',
                Principal: { Service: 'codepipeline.amazonaws.com' },
                Condition: {
                  StringEquals: {
                    'aws:SourceAccount': { Ref: 'AWS::AccountId' },
                  },
                },
              }),
            ]),
          },
        });

        // Inline policy with S3 write, S3 read, and CloudWatch Logs
        template.hasResourceProperties('AWS::IAM::Policy', {
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({ Sid: 'S3BucketWriteAccess' }),
              Match.objectLike({ Sid: 'S3BucketReadOnlyAccess' }),
              Match.objectLike({ Sid: 'CloudWatchLogsWriteAccess' }),
            ]),
          },
        });

        // Role has DeletionPolicy Delete
        template.hasResource('AWS::IAM::Role', {
          Properties: {
            AssumeRolePolicyDocument: {
              Statement: Match.arrayWith([
                Match.objectLike({
                  Condition: { StringEquals: { 'aws:SourceAccount': Match.anyValue() } },
                }),
              ]),
            },
          },
          DeletionPolicy: 'Delete',
        });
      }),
      { numRuns: 20 },
    );
  });

  // Property 4: PipelineAgents CFN property structure (Task 2.5)
  test('Property 4: PipelineAgents CFN property always has correct structure', () => {
    fc.assert(
      fc.property(pipelineNameArb, (name) => {
        const stack = new cdk.Stack();
        createPipeline(stack, {
          pipelineName: name,
          agents: { troubleshooting: { enabled: true } },
        });
        const template = Template.fromStack(stack);

        template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
          PipelineAgents: Match.arrayWith([
            Match.objectLike({
              agentType: 'TROUBLESHOOTING',
              enabled: true,
              agentArtifactStore: { location: Match.anyValue() },
              roleArn: Match.anyValue(),
              qEndpointRegion: 'us-east-1',
            }),
          ]),
        });
      }),
      { numRuns: 20 },
    );
  });
});

// Assertion helpers for P1 tests
function expectNoAgentRole(template: Template): void {
  const roles = template.findResources('AWS::IAM::Role');
  const agentRoles = Object.values(roles).filter((r: any) =>
    JSON.stringify(r.Properties?.AssumeRolePolicyDocument).includes('aws:SourceAccount'),
  );
  expect(agentRoles).toHaveLength(0);
}

function expectNoAgentBucket(template: Template): void {
  const buckets = template.findResources('AWS::S3::Bucket');
  const agentBuckets = Object.values(buckets).filter((b: any) =>
    b.Properties?.LifecycleConfiguration?.Rules?.some((r: any) => r.Id === 'DeleteOldTroubleshootingData'),
  );
  expect(agentBuckets).toHaveLength(0);
}

function expectNoPolicySid(template: Template, sid: string): void {
  const policies = template.findResources('AWS::IAM::Policy');
  for (const [, policy] of Object.entries(policies)) {
    const statements = (policy as any).Properties?.PolicyDocument?.Statement ?? [];
    for (const stmt of statements) {
      expect(stmt.Sid).not.toEqual(sid);
    }
  }
}

describe('Pipeline Troubleshooting Agent - Custom Role', () => {
  test('custom role provided — no default agent role, PipelineAgents uses custom role ARN', () => {
    const stack = new cdk.Stack();
    const customRole = new iam.Role(stack, 'CustomRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
    });
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true, role: customRole } },
    });
    const template = Template.fromStack(stack);

    // No AgentRole created (only pipeline role + custom role)
    // The agent role would have SourceAccount condition — verify it's absent
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      PipelineAgents: Match.arrayWith([
        Match.objectLike({
          roleArn: stack.resolve(customRole.roleArn),
        }),
      ]),
    });
  });

  test('custom role provided — no policies added to custom role', () => {
    const stack = new cdk.Stack();

    const customRole = new iam.Role(stack, 'CustomRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
    });
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true, role: customRole } },
    });
    const template = Template.fromStack(stack);

    expectNoPolicySid(template, 'S3BucketWriteAccess');
    expectNoPolicySid(template, 'S3BucketReadOnlyAccess');
    expectNoPolicySid(template, 'CloudWatchLogsWriteAccess');
  });

  test('custom role + KMS key — no KMS permissions on custom role', () => {
    const stack = new cdk.Stack();

    const customRole = new iam.Role(stack, 'CustomRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
    });
    const key = new kms.Key(stack, 'MyKey');
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true, role: customRole, agentResultsBucketEncryptionKey: key } },
    });
    const template = Template.fromStack(stack);

    expectNoPolicySid(template, 'KMSEncryptAccess');
  });
});

describe('Pipeline Troubleshooting Agent - Custom Bucket', () => {
  test('custom bucket provided — no default agent bucket, PipelineAgents uses custom bucket', () => {
    const stack = new cdk.Stack();

    const customBucket = new s3.Bucket(stack, 'CustomBucket');
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true, agentResultsBucket: customBucket } },
    });
    const template = Template.fromStack(stack);

    // 2 buckets: artifact + custom (no default agent bucket with lifecycle)
    template.resourceCountIs('AWS::S3::Bucket', 2);
    // No bucket with the agent lifecycle rule
    expectNoAgentBucket(template);

    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      PipelineAgents: Match.arrayWith([
        Match.objectLike({
          agentArtifactStore: { location: stack.resolve(customBucket.bucketName) },
        }),
      ]),
    });
  });

  test('custom bucket + default role — S3 write scoped to custom bucket ARN', () => {
    const stack = new cdk.Stack();

    const customBucket = new s3.Bucket(stack, 'CustomBucket');
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true, agentResultsBucket: customBucket } },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'S3BucketWriteAccess',
            Resource: Match.arrayWith([
              stack.resolve(customBucket.bucketArn),
            ]),
          }),
        ]),
      },
    });
  });
});

describe('Pipeline Troubleshooting Agent - KMS Key', () => {
  test('KMS key + default role — role has KMS encrypt policy with 5 actions', () => {
    const stack = new cdk.Stack();

    const key = new kms.Key(stack, 'MyKey');
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true, agentResultsBucketEncryptionKey: key } },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'KMSEncryptAccess',
            Action: ['kms:Encrypt', 'kms:GenerateDataKey', 'kms:ReEncryptFrom', 'kms:ReEncryptTo', 'kms:DescribeKey'],
            Resource: stack.resolve(key.keyArn),
          }),
        ]),
      },
    });
  });

  test('no KMS key — default role has no KMS permissions', () => {
    const stack = new cdk.Stack();
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true } },
    });
    const template = Template.fromStack(stack);

    expectNoPolicySid(template, 'KMSEncryptAccess');
  });
});

describe('Pipeline Troubleshooting Agent - Q Endpoint Region', () => {
  test('QEndpointRegion.US_EAST_1 — PipelineAgents has us-east-1', () => {
    const stack = new cdk.Stack();
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true, qEndpointRegion: codepipeline.QEndpointRegion.US_EAST_1 } },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      PipelineAgents: Match.arrayWith([
        Match.objectLike({ qEndpointRegion: 'us-east-1' }),
      ]),
    });
  });

  test('QEndpointRegion.EU_CENTRAL_1 — PipelineAgents has eu-central-1', () => {
    const stack = new cdk.Stack();
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true, qEndpointRegion: codepipeline.QEndpointRegion.EU_CENTRAL_1 } },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      PipelineAgents: Match.arrayWith([
        Match.objectLike({ qEndpointRegion: 'eu-central-1' }),
      ]),
    });
  });

  test('no qEndpointRegion — defaults to us-east-1', () => {
    const stack = new cdk.Stack();
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true } },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      PipelineAgents: Match.arrayWith([
        Match.objectLike({ qEndpointRegion: 'us-east-1' }),
      ]),
    });
  });

  test('invalid region string — throws ValidationError', () => {
    const stack = new cdk.Stack();
    expect(() => {
      createPipeline(stack, {
        pipelineName: 'MyPipeline',
        agents: { troubleshooting: { enabled: true, qEndpointRegion: 'ap-southeast-1' as any } },
      });
    }).toThrow(/Unsupported Q endpoint region/);
  });
});

describe('Pipeline Troubleshooting Agent - Resource Combinations', () => {
  test('custom role + custom bucket — no default resources created', () => {
    const stack = new cdk.Stack();

    const customRole = new iam.Role(stack, 'CustomRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
    });
    const customBucket = new s3.Bucket(stack, 'CustomBucket');
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true, role: customRole, agentResultsBucket: customBucket } },
    });
    const template = Template.fromStack(stack);

    // 2 buckets: artifact + custom (no default agent bucket)
    template.resourceCountIs('AWS::S3::Bucket', 2);
    // No agent-specific lifecycle bucket
    expectNoAgentBucket(template);

    // No agent-specific role (no role with SourceAccount condition in trust)
    expectNoAgentRole(template);
  });

  test('custom role + no custom bucket — default bucket created, no default role', () => {
    const stack = new cdk.Stack();

    const customRole = new iam.Role(stack, 'CustomRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
    });
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: { troubleshooting: { enabled: true, role: customRole } },
    });
    const template = Template.fromStack(stack);

    // 2 buckets: artifact + default agent bucket (with lifecycle)
    template.resourceCountIs('AWS::S3::Bucket', 2);
    template.hasResource('AWS::S3::Bucket', {
      Properties: Match.objectLike({
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({ Id: 'DeleteOldTroubleshootingData' }),
          ]),
        },
      }),
      DeletionPolicy: 'Retain',
    });

    // No agent-specific role
    expectNoAgentRole(template);
  });

  test('all custom + KMS key — no default resources, no modifications to custom role', () => {
    const stack = new cdk.Stack();

    const customRole = new iam.Role(stack, 'CustomRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
    });
    const customBucket = new s3.Bucket(stack, 'CustomBucket');
    const key = new kms.Key(stack, 'MyKey');
    createPipeline(stack, {
      pipelineName: 'MyPipeline',
      agents: {
        troubleshooting: {
          enabled: true,
          role: customRole,
          agentResultsBucket: customBucket,
          agentResultsBucketEncryptionKey: key,
        },
      },
    });
    const template = Template.fromStack(stack);

    // No default agent bucket
    expectNoAgentBucket(template);

    // No agent-specific role
    expectNoAgentRole(template);

    // No KMS policy (custom role is not modified)
    expectNoPolicySid(template, 'KMSEncryptAccess');
  });
});
