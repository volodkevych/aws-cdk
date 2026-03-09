import * as fc from 'fast-check';
import { Match, Template } from '../../../assertions';
import { Pipeline } from '../../../aws-codepipeline';
import * as cdk from '../../../core';
import { CodePipeline, ShellStep, CodePipelineSource } from '../../lib';
import { TestApp, PIPELINE_ENV } from '../testhelpers';

let app: TestApp;

beforeEach(() => {
  app = new TestApp();
});

afterEach(() => {
  app.cleanup();
});

describe('L3 CodePipeline troubleshooting agent pass-through', () => {
  test('agent property passes through to L2 — agent resources present in synthesized template', () => {
    const pipelineStack = new cdk.Stack(app, 'PipelineStack', { env: PIPELINE_ENV });
    const pipeline = new CodePipeline(pipelineStack, 'Pipeline', {
      pipelineName: 'MyPipeline',
      synth: new ShellStep('Synth', {
        input: CodePipelineSource.gitHub('test/test', 'main'),
        commands: ['npx cdk synth'],
      }),
      agents: { troubleshooting: { enabled: true } },
    });
    pipeline.buildPipeline();

    const template = Template.fromStack(pipelineStack);

    // Agent results bucket should exist (SSE-S3, block public access)
    template.hasResource('AWS::S3::Bucket', {
      Properties: Match.objectLike({
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
      }),
      DeletionPolicy: 'Retain',
    });

    // PipelineAgents property should be on the pipeline resource
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      PipelineAgents: Match.arrayWith([
        Match.objectLike({
          agentType: 'TROUBLESHOOTING',
          enabled: true,
          qEndpointRegion: 'us-east-1',
        }),
      ]),
    });
  });

  test('throws ValidationError when both codePipeline and agents are set', () => {
    const pipelineStack = new cdk.Stack(app, 'PipelineStack', { env: PIPELINE_ENV });

    expect(() => {
      const pipeline = new CodePipeline(pipelineStack, 'Pipeline', {
        codePipeline: new Pipeline(pipelineStack, 'ExistingPipeline'),
        synth: new ShellStep('Synth', {
          input: CodePipelineSource.gitHub('test/test', 'main'),
          commands: ['npx cdk synth'],
        }),
        agents: { troubleshooting: { enabled: true } },
      });
      pipeline.buildPipeline();
    }).toThrow(/Cannot set 'agents' if an existing CodePipeline is given using 'codePipeline'/);
  });
});

const pipelineNameArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'.split('')),
  { minLength: 1, maxLength: 100 },
).filter(s => /^[A-Za-z]/.test(s));

describe('L3 CodePipeline troubleshooting agent - Property Tests', () => {
  // Property 5: L3 passes agents through to L2 (Task 4.3)
  test('Property 5: L3 CodePipeline always passes agents through to L2', () => {
    fc.assert(
      fc.property(pipelineNameArb, (name) => {
        const testApp = new TestApp();
        try {
          const pipelineStack = new cdk.Stack(testApp, 'PipelineStack', { env: PIPELINE_ENV });
          const pipeline = new CodePipeline(pipelineStack, 'Pipeline', {
            pipelineName: name,
            synth: new ShellStep('Synth', {
              input: CodePipelineSource.gitHub('test/test', 'main'),
              commands: ['npx cdk synth'],
            }),
            agents: { troubleshooting: { enabled: true } },
          });
          pipeline.buildPipeline();

          const template = Template.fromStack(pipelineStack);

          // Agent bucket exists
          template.hasResource('AWS::S3::Bucket', {
            Properties: Match.objectLike({
              BucketEncryption: {
                ServerSideEncryptionConfiguration: [{
                  ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
                }],
              },
            }),
            DeletionPolicy: 'Retain',
          });

          // PipelineAgents property present
          template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
            PipelineAgents: Match.arrayWith([
              Match.objectLike({
                agentType: 'TROUBLESHOOTING',
                enabled: true,
                qEndpointRegion: 'us-east-1',
              }),
            ]),
          });
        } finally {
          testApp.cleanup();
        }
      }),
      { numRuns: 10 },
    );
  });

  // Property 6: L3 disabled agent produces no agent resources
  test('Property 6: disabling agent at L3 never produces agent resources', () => {
    fc.assert(
      fc.property(pipelineNameArb, fc.constantFrom(undefined, false), (name, enabled) => {
        const testApp = new TestApp();
        try {
          const pipelineStack = new cdk.Stack(testApp, 'PipelineStack', { env: PIPELINE_ENV });
          const agentsProp = enabled === undefined
            ? {}
            : { agents: { troubleshooting: { enabled } } };
          const pipeline = new CodePipeline(pipelineStack, 'Pipeline', {
            pipelineName: name,
            synth: new ShellStep('Synth', {
              input: CodePipelineSource.gitHub('test/test', 'main'),
              commands: ['npx cdk synth'],
            }),
            ...agentsProp,
          });
          pipeline.buildPipeline();

          const template = Template.fromStack(pipelineStack);
          template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
            PipelineAgents: Match.absent(),
          });
        } finally {
          testApp.cleanup();
        }
      }),
      { numRuns: 10 },
    );
  });
});
