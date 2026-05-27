import { Match, Template } from '../../../assertions';
import * as codebuild from '../../../aws-codebuild';
import * as codecommit from '../../../aws-codecommit';
import * as codepipeline from '../../../aws-codepipeline';
import * as iam from '../../../aws-iam';
import * as s3 from '../../../aws-s3';
import * as sns from '../../../aws-sns';
import { App, PhysicalName, SecretValue, Stack } from '../../../core';
import * as cpactions from '../../lib';

/* eslint-disable @stylistic/quote-props */

describe('CodeBuild Action', () => {
  describe('CodeBuild action', () => {
    describe('that is cross-account and has outputs', () => {
      test('causes an error', () => {
        const app = new App();

        const projectStack = new Stack(app, 'ProjectStack', {
          env: {
            region: 'us-west-2',
            account: '012345678912',
          },
        });
        const project = new codebuild.PipelineProject(projectStack, 'Project');

        const pipelineStack = new Stack(app, 'PipelineStack', {
          env: {
            region: 'us-west-2',
            account: '012345678913',
          },
        });
        const sourceOutput = new codepipeline.Artifact();
        const pipeline = new codepipeline.Pipeline(pipelineStack, 'Pipeline', {
          stages: [
            {
              stageName: 'Source',
              actions: [new cpactions.CodeCommitSourceAction({
                actionName: 'CodeCommit',
                repository: codecommit.Repository.fromRepositoryName(pipelineStack, 'Repo', 'repo-name'),
                output: sourceOutput,
              })],
            },
          ],
        });
        const buildStage = pipeline.addStage({
          stageName: 'Build',
        });

        // this works fine - no outputs!
        buildStage.addAction(new cpactions.CodeBuildAction({
          actionName: 'Build1',
          input: sourceOutput,
          project,
        }));

        const buildAction2 = new cpactions.CodeBuildAction({
          actionName: 'Build2',
          input: sourceOutput,
          project,
          outputs: [new codepipeline.Artifact()],
        });

        expect(() => {
          buildStage.addAction(buildAction2);
        }).toThrow(/https:\/\/github\.com\/aws\/aws-cdk\/issues\/4169/);
      });
    });

    test('can be backed by an imported project', () => {
      const stack = new Stack();

      const codeBuildProject = codebuild.PipelineProject.fromProjectName(stack, 'CodeBuild',
        'codeBuildProjectNameInAnotherAccount');

      const sourceOutput = new codepipeline.Artifact();
      new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [
              new cpactions.S3SourceAction({
                actionName: 'S3_Source',
                bucket: new s3.Bucket(stack, 'Bucket'),
                bucketKey: 'key',
                output: sourceOutput,
              }),
            ],
          },
          {
            stageName: 'Build',
            actions: [
              new cpactions.CodeBuildAction({
                actionName: 'CodeBuild',
                input: sourceOutput,
                project: codeBuildProject,
              }),
            ],
          },
        ],
      });

      Template.fromStack(stack).hasResourceProperties('AWS::CodePipeline::Pipeline', {
        'Stages': [
          {
            'Name': 'Source',
          },
          {
            'Name': 'Build',
            'Actions': [
              {
                'Name': 'CodeBuild',
                'Configuration': {
                  'ProjectName': 'codeBuildProjectNameInAnotherAccount',
                },
              },
            ],
          },
        ],
      });
    });

    test('exposes variables for other actions to consume', () => {
      const stack = new Stack();

      const sourceOutput = new codepipeline.Artifact();
      const codeBuildAction = new cpactions.CodeBuildAction({
        actionName: 'CodeBuild',
        input: sourceOutput,
        project: new codebuild.PipelineProject(stack, 'CodeBuild', {
          buildSpec: codebuild.BuildSpec.fromObject({
            version: '0.2',
            env: {
              'exported-variables': [
                'SomeVar',
              ],
            },
            phases: {
              build: {
                commands: [
                  'export SomeVar="Some Value"',
                ],
              },
            },
          }),
        }),
      });
      new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [
              new cpactions.S3SourceAction({
                actionName: 'S3_Source',
                bucket: s3.Bucket.fromBucketName(stack, 'Bucket', 'bucket'),
                bucketKey: 'key',
                output: sourceOutput,
              }),
            ],
          },
          {
            stageName: 'Build',
            actions: [
              codeBuildAction,
              new cpactions.ManualApprovalAction({
                actionName: 'Approve',
                additionalInformation: codeBuildAction.variable('SomeVar'),
                notificationTopic: sns.Topic.fromTopicArn(stack, 'Topic', 'arn:aws:sns:us-east-1:123456789012:mytopic'),
                runOrder: 2,
              }),
            ],
          },
        ],
      });

      Template.fromStack(stack).hasResourceProperties('AWS::CodePipeline::Pipeline', {
        'Stages': [
          {
            'Name': 'Source',
          },
          {
            'Name': 'Build',
            'Actions': [
              {
                'Name': 'CodeBuild',
                'Namespace': 'Build_CodeBuild_NS',
              },
              {
                'Name': 'Approve',
                'Configuration': {
                  'CustomData': '#{Build_CodeBuild_NS.SomeVar}',
                },
              },
            ],
          },
        ],
      });
    });

    test('sets the BatchEnabled configuration', () => {
      const stack = new Stack();

      const codeBuildProject = new codebuild.PipelineProject(stack, 'CodeBuild');

      const sourceOutput = new codepipeline.Artifact();
      new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [
              new cpactions.S3SourceAction({
                actionName: 'S3_Source',
                bucket: new s3.Bucket(stack, 'Bucket'),
                bucketKey: 'key',
                output: sourceOutput,
              }),
            ],
          },
          {
            stageName: 'Build',
            actions: [
              new cpactions.CodeBuildAction({
                actionName: 'CodeBuild',
                input: sourceOutput,
                project: codeBuildProject,
                executeBatchBuild: true,
              }),
            ],
          },
        ],
      });

      Template.fromStack(stack).hasResourceProperties('AWS::CodePipeline::Pipeline', {
        'Stages': [
          {
            'Name': 'Source',
          },
          {
            'Name': 'Build',
            'Actions': [
              {
                'Name': 'CodeBuild',
                'Configuration': {
                  'BatchEnabled': 'true',
                },
              },
            ],
          },
        ],
      });
    });

    test('sets the CombineArtifacts configuration', () => {
      const stack = new Stack();

      const codeBuildProject = new codebuild.PipelineProject(stack, 'CodeBuild');

      const sourceOutput = new codepipeline.Artifact();
      new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [
              new cpactions.S3SourceAction({
                actionName: 'S3_Source',
                bucket: new s3.Bucket(stack, 'Bucket'),
                bucketKey: 'key',
                output: sourceOutput,
              }),
            ],
          },
          {
            stageName: 'Build',
            actions: [
              new cpactions.CodeBuildAction({
                actionName: 'CodeBuild',
                input: sourceOutput,
                project: codeBuildProject,
                executeBatchBuild: true,
                combineBatchBuildArtifacts: true,
              }),
            ],
          },
        ],
      });

      Template.fromStack(stack).hasResourceProperties('AWS::CodePipeline::Pipeline', {
        'Stages': [
          {
            'Name': 'Source',
          },
          {
            'Name': 'Build',
            'Actions': [
              {
                'Name': 'CodeBuild',
                'Configuration': {
                  'BatchEnabled': 'true',
                  'CombineArtifacts': 'true',
                },
              },
            ],
          },
        ],
      });
    });

    describe('environment variables', () => {
      test('should fail by default when added to a Pipeline while using a secret value in a plaintext variable', () => {
        const stack = new Stack();

        const sourceOutput = new codepipeline.Artifact();
        const pipeline = new codepipeline.Pipeline(stack, 'Pipeline', {
          stages: [
            {
              stageName: 'Source',
              actions: [new cpactions.CodeCommitSourceAction({
                actionName: 'source',
                repository: new codecommit.Repository(stack, 'CodeCommitRepo', {
                  repositoryName: 'my-repo',
                }),
                output: sourceOutput,
              })],
            },
          ],
        });

        const buildStage = pipeline.addStage({
          stageName: 'Build',
        });
        const codeBuildProject = new codebuild.PipelineProject(stack, 'CodeBuild');
        const buildAction = new cpactions.CodeBuildAction({
          actionName: 'Build',
          project: codeBuildProject,
          input: sourceOutput,
          environmentVariables: {
            'X': {
              value: SecretValue.secretsManager('my-secret'),
            },
          },
        });

        expect(() => {
          buildStage.addAction(buildAction);
        }).toThrow(/Plaintext environment variable 'X' contains a secret value!/);
      });

      test("should allow opting out of the 'secret value in a plaintext variable' validation", () => {
        const stack = new Stack();

        const sourceOutput = new codepipeline.Artifact();
        new codepipeline.Pipeline(stack, 'Pipeline', {
          stages: [
            {
              stageName: 'Source',
              actions: [new cpactions.CodeCommitSourceAction({
                actionName: 'source',
                repository: new codecommit.Repository(stack, 'CodeCommitRepo', {
                  repositoryName: 'my-repo',
                }),
                output: sourceOutput,
              })],
            },
            {
              stageName: 'Build',
              actions: [new cpactions.CodeBuildAction({
                actionName: 'build',
                project: new codebuild.PipelineProject(stack, 'CodeBuild'),
                input: sourceOutput,
                environmentVariables: {
                  'X': {
                    value: SecretValue.secretsManager('my-secret'),
                  },
                },
                checkSecretsInPlainTextEnvVariables: false,
              })],
            },
          ],
        });
      });
    });
  });

  describe('serviceRoleOverride', () => {
    test('explicit prop sets ServiceRoleArnOverride in action configuration', () => {
      const stack = new Stack();

      const overrideRole = new iam.Role(stack, 'OverrideRole', {
        assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      });

      const sourceOutput = new codepipeline.Artifact();
      new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [new cpactions.CodeStarConnectionsSourceAction({
              actionName: 'Source',
              owner: 'aws',
              repo: 'aws-cdk',
              output: sourceOutput,
              connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/12345678-abcd-12ab-34cdef5678gh',
            })],
          },
          {
            stageName: 'Build',
            actions: [new cpactions.CodeBuildAction({
              actionName: 'Build',
              project: new codebuild.PipelineProject(stack, 'MyProject'),
              input: sourceOutput,
              serviceRoleOverride: overrideRole,
            })],
          },
        ],
      });

      Template.fromStack(stack).hasResourceProperties('AWS::CodePipeline::Pipeline', {
        Stages: Match.arrayWith([
          Match.objectLike({
            Name: 'Build',
            Actions: Match.arrayWith([
              Match.objectLike({
                Configuration: Match.objectLike({
                  ServiceRoleArnOverride: { 'Fn::GetAtt': [Match.stringLikeRegexp('OverrideRole'), 'Arn'] },
                }),
              }),
            ]),
          }),
        ]),
      });
    });

    test('explicit prop grants iam:PassRole to pipeline role', () => {
      const stack = new Stack();

      const overrideRole = new iam.Role(stack, 'OverrideRole', {
        assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      });

      const sourceOutput = new codepipeline.Artifact();
      new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [new cpactions.CodeStarConnectionsSourceAction({
              actionName: 'Source',
              owner: 'aws',
              repo: 'aws-cdk',
              output: sourceOutput,
              connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/12345678-abcd-12ab-34cdef5678gh',
            })],
          },
          {
            stageName: 'Build',
            actions: [new cpactions.CodeBuildAction({
              actionName: 'Build',
              project: new codebuild.PipelineProject(stack, 'MyProject'),
              input: sourceOutput,
              serviceRoleOverride: overrideRole,
            })],
          },
        ],
      });

      Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'iam:PassRole',
              Effect: 'Allow',
              Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('OverrideRole'), 'Arn'] },
            }),
          ]),
        },
      });
    });

    test('no ServiceRoleArnOverride when prop is not provided', () => {
      const stack = new Stack();

      const sourceOutput = new codepipeline.Artifact();
      new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [new cpactions.CodeStarConnectionsSourceAction({
              actionName: 'Source',
              owner: 'aws',
              repo: 'aws-cdk',
              output: sourceOutput,
              connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/12345678-abcd-12ab-34cdef5678gh',
            })],
          },
          {
            stageName: 'Build',
            actions: [new cpactions.CodeBuildAction({
              actionName: 'Build',
              project: new codebuild.PipelineProject(stack, 'MyProject'),
              input: sourceOutput,
            })],
          },
        ],
      });

      const template = Template.fromStack(stack);
      const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
      const pipelineResource = Object.values(pipelines)[0];
      const buildAction = pipelineResource.Properties.Stages[1].Actions[0];
      expect(buildAction.Configuration.ServiceRoleArnOverride).toBeUndefined();
    });

    test('feature flag auto-creates scoped role when Full Clone source is detected', () => {
      const app = new App({
        context: {
          '@aws-cdk/aws-codepipeline-actions:useServiceRoleOverrideForCodeBuild': true,
        },
      });
      const stack = new Stack(app, 'TestStack');

      const sourceOutput = new codepipeline.Artifact();
      new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [new cpactions.CodeStarConnectionsSourceAction({
              actionName: 'Source',
              owner: 'my-owner',
              repo: 'my-repo',
              output: sourceOutput,
              connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/12345678-abcd-12ab-34cdef5678gh',
              codeBuildCloneOutput: true,
            })],
          },
          {
            stageName: 'Build',
            actions: [new cpactions.CodeBuildAction({
              actionName: 'Build',
              project: new codebuild.PipelineProject(stack, 'MyProject'),
              input: sourceOutput,
            })],
          },
        ],
      });

      const template = Template.fromStack(stack);

      // Verify ServiceRoleArnOverride is set in pipeline config
      template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
        Stages: Match.arrayWith([
          Match.objectLike({
            Name: 'Build',
            Actions: Match.arrayWith([
              Match.objectLike({
                Configuration: Match.objectLike({
                  ServiceRoleArnOverride: Match.anyValue(),
                }),
              }),
            ]),
          }),
        ]),
      });

      // Verify the auto-created role has CodeBuild trust
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Action: 'sts:AssumeRole',
              Effect: 'Allow',
              Principal: { Service: 'codebuild.amazonaws.com' },
            }),
          ],
        },
      });

      // Verify the CodeConnections statement has FullRepositoryId condition
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'codeconnections:UseConnection',
              ]),
              Condition: {
                StringEquals: {
                  'codeconnections:FullRepositoryId': 'my-owner/my-repo',
                },
              },
              Resource: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/12345678-abcd-12ab-34cdef5678gh',
            }),
          ]),
        },
      });
    });

    test('feature flag does nothing when disabled', () => {
      const app = new App({
        context: {
          '@aws-cdk/aws-codepipeline-actions:useServiceRoleOverrideForCodeBuild': false,
        },
      });
      const stack = new Stack(app, 'TestStack');

      const sourceOutput = new codepipeline.Artifact();
      new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [new cpactions.CodeStarConnectionsSourceAction({
              actionName: 'Source',
              owner: 'my-owner',
              repo: 'my-repo',
              output: sourceOutput,
              connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/12345678-abcd-12ab-34cdef5678gh',
              codeBuildCloneOutput: true,
            })],
          },
          {
            stageName: 'Build',
            actions: [new cpactions.CodeBuildAction({
              actionName: 'Build',
              project: new codebuild.PipelineProject(stack, 'MyProject'),
              input: sourceOutput,
            })],
          },
        ],
      });

      const template = Template.fromStack(stack);
      const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
      const pipelineResource = Object.values(pipelines)[0];
      const buildAction = pipelineResource.Properties.Stages[1].Actions[0];
      expect(buildAction.Configuration.ServiceRoleArnOverride).toBeUndefined();
    });

    test('explicit prop takes precedence over feature flag', () => {
      const app = new App({
        context: {
          '@aws-cdk/aws-codepipeline-actions:useServiceRoleOverrideForCodeBuild': true,
        },
      });
      const stack = new Stack(app, 'TestStack');

      const overrideRole = new iam.Role(stack, 'MyCustomRole', {
        assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      });

      const sourceOutput = new codepipeline.Artifact();
      new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [new cpactions.CodeStarConnectionsSourceAction({
              actionName: 'Source',
              owner: 'my-owner',
              repo: 'my-repo',
              output: sourceOutput,
              connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/12345678-abcd-12ab-34cdef5678gh',
              codeBuildCloneOutput: true,
            })],
          },
          {
            stageName: 'Build',
            actions: [new cpactions.CodeBuildAction({
              actionName: 'Build',
              project: new codebuild.PipelineProject(stack, 'MyProject'),
              input: sourceOutput,
              serviceRoleOverride: overrideRole,
            })],
          },
        ],
      });

      const template = Template.fromStack(stack);

      // Should use the explicitly provided role
      template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
        Stages: Match.arrayWith([
          Match.objectLike({
            Name: 'Build',
            Actions: Match.arrayWith([
              Match.objectLike({
                Configuration: Match.objectLike({
                  ServiceRoleArnOverride: { 'Fn::GetAtt': [Match.stringLikeRegexp('MyCustomRole'), 'Arn'] },
                }),
              }),
            ]),
          }),
        ]),
      });
    });

    test('feature flag does not trigger when input is not from Full Clone source', () => {
      const app = new App({
        context: {
          '@aws-cdk/aws-codepipeline-actions:useServiceRoleOverrideForCodeBuild': true,
        },
      });
      const stack = new Stack(app, 'TestStack');

      const sourceOutput = new codepipeline.Artifact();
      new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [new cpactions.CodeStarConnectionsSourceAction({
              actionName: 'Source',
              owner: 'my-owner',
              repo: 'my-repo',
              output: sourceOutput,
              connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/12345678-abcd-12ab-34cdef5678gh',
              codeBuildCloneOutput: false,
            })],
          },
          {
            stageName: 'Build',
            actions: [new cpactions.CodeBuildAction({
              actionName: 'Build',
              project: new codebuild.PipelineProject(stack, 'MyProject'),
              input: sourceOutput,
            })],
          },
        ],
      });

      const template = Template.fromStack(stack);
      const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
      const pipelineResource = Object.values(pipelines)[0];
      const buildAction = pipelineResource.Properties.Stages[1].Actions[0];
      expect(buildAction.Configuration.ServiceRoleArnOverride).toBeUndefined();
    });

    test('feature flag creates role in project account for cross-account pipelines', () => {
      const app = new App({
        context: {
          '@aws-cdk/aws-codepipeline-actions:useServiceRoleOverrideForCodeBuild': true,
        },
      });

      const projectStack = new Stack(app, 'ProjectStack', {
        env: { region: 'us-west-2', account: '111111111111' },
      });
      const project = new codebuild.PipelineProject(projectStack, 'Project', {
        projectName: PhysicalName.GENERATE_IF_NEEDED,
      });

      const pipelineStack = new Stack(app, 'PipelineStack', {
        env: { region: 'us-west-2', account: '222222222222' },
      });

      const sourceOutput = new codepipeline.Artifact();
      new codepipeline.Pipeline(pipelineStack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [new cpactions.CodeStarConnectionsSourceAction({
              actionName: 'Source',
              owner: 'my-owner',
              repo: 'my-repo',
              output: sourceOutput,
              connectionArn: 'arn:aws:codestar-connections:us-west-2:111111111111:connection/12345678-abcd-12ab-34cdef5678gh',
              codeBuildCloneOutput: true,
            })],
          },
          {
            stageName: 'Build',
            actions: [new cpactions.CodeBuildAction({
              actionName: 'Build',
              project,
              input: sourceOutput,
            })],
          },
        ],
      });

      // The override role should be in the project's stack (account 111111111111)
      const projectTemplate = Template.fromStack(projectStack);
      projectTemplate.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Principal: { Service: 'codebuild.amazonaws.com' },
            }),
          ],
        },
      });
    });

    test('feature flag with multiple inputs uses the Full Clone one', () => {
      const app = new App({
        context: {
          '@aws-cdk/aws-codepipeline-actions:useServiceRoleOverrideForCodeBuild': true,
        },
      });
      const stack = new Stack(app, 'TestStack');

      const sourceOutput1 = new codepipeline.Artifact('Source1');
      const sourceOutput2 = new codepipeline.Artifact('Source2');

      new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [
              new cpactions.CodeStarConnectionsSourceAction({
                actionName: 'FullCloneSource',
                owner: 'my-owner',
                repo: 'my-repo',
                output: sourceOutput1,
                connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/12345678-abcd-12ab-34cdef5678gh',
                codeBuildCloneOutput: true,
              }),
              new cpactions.S3SourceAction({
                actionName: 'S3Source',
                bucket: new s3.Bucket(stack, 'Bucket'),
                bucketKey: 'key',
                output: sourceOutput2,
              }),
            ],
          },
          {
            stageName: 'Build',
            actions: [new cpactions.CodeBuildAction({
              actionName: 'Build',
              project: new codebuild.PipelineProject(stack, 'MyProject'),
              input: sourceOutput1,
              extraInputs: [sourceOutput2],
            })],
          },
        ],
      });

      const template = Template.fromStack(stack);

      // Should still create the override role using the Full Clone input's metadata
      template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
        Stages: Match.arrayWith([
          Match.objectLike({
            Name: 'Build',
            Actions: Match.arrayWith([
              Match.objectLike({
                Configuration: Match.objectLike({
                  ServiceRoleArnOverride: Match.anyValue(),
                }),
              }),
            ]),
          }),
        ]),
      });

      // Verify condition uses the correct repo
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Condition: {
                StringEquals: {
                  'codeconnections:FullRepositoryId': 'my-owner/my-repo',
                },
              },
            }),
          ]),
        },
      });
    });
  });
});
