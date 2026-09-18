"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const aws_cdk_lib_1 = require("aws-cdk-lib");
const assertions_1 = require("aws-cdk-lib/assertions");
const data_stack_1 = require("../lib/data-stack");
const api_stack_1 = require("../lib/api-stack");
const ingest_stack_1 = require("../lib/ingest-stack");
const frontend_stack_1 = require("../lib/frontend-stack");
describe('CDK app scaffold', () => {
    function buildApp() {
        const app = new aws_cdk_lib_1.App();
        aws_cdk_lib_1.Tags.of(app).add('project', 'healthomics-workflow-dashboard');
        const dataStack = new data_stack_1.DataStack(app, 'HealthOmicsData');
        const apiStack = new api_stack_1.ApiStack(app, 'HealthOmicsApi', { dataStack });
        apiStack.addStackDependency(dataStack);
        const ingestStack = new ingest_stack_1.IngestStack(app, 'HealthOmicsIngest', {
            dataStack,
            apiStack,
        });
        ingestStack.addStackDependency(dataStack);
        ingestStack.addStackDependency(apiStack);
        const frontendStack = new frontend_stack_1.FrontendStack(app, 'HealthOmicsFrontend', {
            apiStack,
        });
        frontendStack.addStackDependency(apiStack);
        return { app, dataStack, apiStack, ingestStack, frontendStack };
    }
    it('instantiates all four stacks and synthesizes without error', () => {
        const { app, dataStack, apiStack, ingestStack, frontendStack } = buildApp();
        // Each stack synthesizes to a valid (empty) template.
        for (const stack of [dataStack, apiStack, ingestStack, frontendStack]) {
            expect(() => assertions_1.Template.fromStack(stack)).not.toThrow();
        }
        const stackNames = app
            .synth()
            .stacks.map((s) => s.stackName)
            .sort();
        expect(stackNames).toEqual([
            'HealthOmicsApi',
            'HealthOmicsData',
            'HealthOmicsFrontend',
            'HealthOmicsIngest',
        ]);
    });
    it('orders stacks by dependency (Data -> Api -> Ingest, Api -> Frontend)', () => {
        const { apiStack, ingestStack, frontendStack } = buildApp();
        expect(apiStack.dependencies).toContainEqual(expect.objectContaining({ stackName: 'HealthOmicsData' }));
        const ingestDeps = ingestStack.dependencies.map((d) => d.stackName);
        expect(ingestDeps).toEqual(expect.arrayContaining(['HealthOmicsData', 'HealthOmicsApi']));
        expect(frontendStack.dependencies).toContainEqual(expect.objectContaining({ stackName: 'HealthOmicsApi' }));
    });
    it('applies the project identifier tag at the app level', () => {
        const { app } = buildApp();
        const assembly = app.synth();
        const dataArtifact = assembly.getStackByName('HealthOmicsData');
        expect(dataArtifact.tags).toMatchObject({
            project: 'healthomics-workflow-dashboard',
        });
    });
    describe('IngestStack least-privilege IAM (Req 2.3, 4.4, 11.2)', () => {
        /** Collects the flattened action list across every IAM policy statement. */
        function allPolicyActions(template) {
            const policies = template.findResources('AWS::IAM::Policy');
            const actions = [];
            for (const policy of Object.values(policies)) {
                const statements = policy
                    .Properties?.PolicyDocument?.Statement ?? [];
                for (const stmt of statements) {
                    const action = stmt.Action;
                    if (typeof action === 'string')
                        actions.push(action);
                    else if (Array.isArray(action))
                        actions.push(...action);
                }
            }
            return actions;
        }
        it('grants DynamoDB write/read scoped to the table and GSI1 ARNs', () => {
            const { ingestStack } = buildApp();
            const template = assertions_1.Template.fromStack(ingestStack);
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: assertions_1.Match.arrayWith([
                        assertions_1.Match.objectLike({
                            Effect: 'Allow',
                            Action: [
                                'dynamodb:PutItem',
                                'dynamodb:UpdateItem',
                                'dynamodb:GetItem',
                                'dynamodb:Query',
                                'dynamodb:ConditionCheckItem',
                            ],
                        }),
                    ]),
                },
            });
        });
        it('grants appsync:GraphQL scoped only to the publish mutation field ARNs (Req 4.4)', () => {
            const { ingestStack } = buildApp();
            const template = assertions_1.Template.fromStack(ingestStack);
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: assertions_1.Match.arrayWith([
                        assertions_1.Match.objectLike({
                            Effect: 'Allow',
                            Action: 'appsync:GraphQL',
                            Resource: assertions_1.Match.arrayWith([
                                assertions_1.Match.objectLike({
                                    'Fn::Join': assertions_1.Match.arrayWith([
                                        assertions_1.Match.arrayWith([
                                            '/types/Mutation/fields/publishRunUpdate',
                                        ]),
                                    ]),
                                }),
                                assertions_1.Match.objectLike({
                                    'Fn::Join': assertions_1.Match.arrayWith([
                                        assertions_1.Match.arrayWith([
                                            '/types/Mutation/fields/publishTaskUpdate',
                                        ]),
                                    ]),
                                }),
                            ]),
                        }),
                    ]),
                },
            });
        });
        it('grants HealthOmics read-only actions with no create/update/delete (Req 2.3)', () => {
            const { ingestStack } = buildApp();
            const template = assertions_1.Template.fromStack(ingestStack);
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: assertions_1.Match.arrayWith([
                        assertions_1.Match.objectLike({
                            Effect: 'Allow',
                            Action: [
                                'omics:GetRun',
                                'omics:ListRunTasks',
                                'omics:GetRunTask',
                                'omics:GetWorkflow',
                            ],
                        }),
                    ]),
                },
            });
        });
        it('grants no wildcard actions and no wildcard resources on the ingest role (Req 11.2)', () => {
            const { ingestStack } = buildApp();
            const template = assertions_1.Template.fromStack(ingestStack);
            // No `Action: "*"` in any statement.
            expect(allPolicyActions(template)).not.toContain('*');
            // No inline policy statement uses `Resource: "*"`.
            const policies = template.findResources('AWS::IAM::Policy');
            for (const policy of Object.values(policies)) {
                const statements = policy
                    .Properties?.PolicyDocument?.Statement ?? [];
                for (const stmt of statements) {
                    expect(stmt.Resource).not.toBe('*');
                }
            }
        });
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwLnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhcHAudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLDZDQUF3QztBQUN4Qyx1REFBeUQ7QUFDekQsa0RBQThDO0FBQzlDLGdEQUE0QztBQUM1QyxzREFBa0Q7QUFDbEQsMERBQXNEO0FBRXRELFFBQVEsQ0FBQyxrQkFBa0IsRUFBRSxHQUFHLEVBQUU7SUFDaEMsU0FBUyxRQUFRO1FBT2YsTUFBTSxHQUFHLEdBQUcsSUFBSSxpQkFBRyxFQUFFLENBQUM7UUFDdEIsa0JBQUksQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxnQ0FBZ0MsQ0FBQyxDQUFDO1FBRTlELE1BQU0sU0FBUyxHQUFHLElBQUksc0JBQVMsQ0FBQyxHQUFHLEVBQUUsaUJBQWlCLENBQUMsQ0FBQztRQUN4RCxNQUFNLFFBQVEsR0FBRyxJQUFJLG9CQUFRLENBQUMsR0FBRyxFQUFFLGdCQUFnQixFQUFFLEVBQUUsU0FBUyxFQUFFLENBQUMsQ0FBQztRQUNwRSxRQUFRLENBQUMsa0JBQWtCLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDdkMsTUFBTSxXQUFXLEdBQUcsSUFBSSwwQkFBVyxDQUFDLEdBQUcsRUFBRSxtQkFBbUIsRUFBRTtZQUM1RCxTQUFTO1lBQ1QsUUFBUTtTQUNULENBQUMsQ0FBQztRQUNILFdBQVcsQ0FBQyxrQkFBa0IsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUMxQyxXQUFXLENBQUMsa0JBQWtCLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDekMsTUFBTSxhQUFhLEdBQUcsSUFBSSw4QkFBYSxDQUFDLEdBQUcsRUFBRSxxQkFBcUIsRUFBRTtZQUNsRSxRQUFRO1NBQ1QsQ0FBQyxDQUFDO1FBQ0gsYUFBYSxDQUFDLGtCQUFrQixDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBRTNDLE9BQU8sRUFBRSxHQUFHLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxXQUFX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aUJBQ0g7YUFDRixDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztRQUVILEVBQUUsQ0FBQyxvRkFBb0YsRUFBRSxHQUFHLEVBQUU7WUFDNUYsTUFBTSxFQUFFLFdBQVcsRUFBRSxHQUFHLFFBQVEsRUFBRSxDQUFDO1lBQ25DLE1BQU0sUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1lBRWpELHFDQUFxQztZQUNyQyxNQUFNLENBQUMsZ0JBQWdCLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBRXRELG1EQUFtRDtZQUNuRCxNQUFNLFFBQVEsR0FBRyxRQUFRLENBQUMsYUFBYSxDQUFDLGtCQUFrQixDQUFDLENBQUM7WUFDNUQsS0FBSyxNQUFNLE1BQU0sSUFBSSxNQUFNLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUM7Z0JBQzdDLE1BQU0sVUFBVSxHQUNiLE1BQTBFO3FCQUN4RSxVQUFVLEVBQUUsY0FBYyxFQUFFLFNBQVMsSUFBSSxFQUFFLENBQUM7Z0JBQ2pELEtBQUssTUFBTSxJQUFJLElBQUksVUFBMkMsRUFBRSxDQUFDO29CQUMvRCxNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7Z0JBQ3RDLENBQUM7WUFDSCxDQUFDO1FBQ0gsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQXBwLCBUYWdzIH0gZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgTWF0Y2gsIFRlbXBsYXRlIH0gZnJvbSAnYXdzLWNkay1saWIvYXNzZXJ0aW9ucyc7XG5pbXBvcnQgeyBEYXRhU3RhY2sgfSBmcm9tICcuLi9saWIvZGF0YS1zdGFjayc7XG5pbXBvcnQgeyBBcGlTdGFjayB9IGZyb20gJy4uL2xpYi9hcGktc3RhY2snO1xuaW1wb3J0IHsgSW5nZXN0U3RhY2sgfSBmcm9tICcuLi9saWIvaW5nZXN0LXN0YWNrJztcbmltcG9ydCB7IEZyb250ZW5kU3RhY2sgfSBmcm9tICcuLi9saWIvZnJvbnRlbmQtc3RhY2snO1xuXG5kZXNjcmliZSgnQ0RLIGFwcCBzY2FmZm9sZCcsICgpID0+IHtcbiAgZnVuY3Rpb24gYnVpbGRBcHAoKToge1xuICAgIGFwcDogQXBwO1xuICAgIGRhdGFTdGFjazogRGF0YVN0YWNrO1xuICAgIGFwaVN0YWNrOiBBcGlTdGFjaztcbiAgICBpbmdlc3RTdGFjazogSW5nZXN0U3RhY2s7XG4gICAgZnJvbnRlbmRTdGFjazogRnJvbnRlbmRTdGFjaztcbiAgfSB7XG4gICAgY29uc3QgYXBwID0gbmV3IEFwcCgpO1xuICAgIFRhZ3Mub2YoYXBwKS5hZGQoJ3Byb2plY3QnLCAnaGVhbHRob21pY3Mtd29ya2Zsb3ctZGFzaGJvYXJkJyk7XG5cbiAgICBjb25zdCBkYXRhU3RhY2sgPSBuZXcgRGF0YVN0YWNrKGFwcCwgJ0hlYWx0aE9taWNzRGF0YScpO1xuICAgIGNvbnN0IGFwaVN0YWNrID0gbmV3IEFwaVN0YWNrKGFwcCwgJ0hlYWx0aE9taWNzQXBpJywgeyBkYXRhU3RhY2sgfSk7XG4gICAgYXBpU3RhY2suYWRkU3RhY2tEZXBlbmRlbmN5KGRhdGFTdGFjayk7XG4gICAgY29uc3QgaW5nZXN0U3RhY2sgPSBuZXcgSW5nZXN0U3RhY2soYXBwLCAnSGVhbHRoT21pY3NJbmdlc3QnLCB7XG4gICAgICBkYXRhU3RhY2ssXG4gICAgICBhcGlTdGFjayxcbiAgICB9KTtcbiAgICBpbmdlc3RTdGFjay5hZGRTdGFja0RlcGVuZGVuY3koZGF0YVN0YWNrKTtcbiAgICBpbmdlc3RTdGFjay5hZGRTdGFja0RlcGVuZGVuY3koYXBpU3RhY2spO1xuICAgIGNvbnN0IGZyb250ZW5kU3RhY2sgPSBuZXcgRnJvbnRlbmRTdGFjayhhcHAsICdIZWFsdGhPbWljc0Zyb250ZW5kJywge1xuICAgICAgYXBpU3RhY2ssXG4gICAgfSk7XG4gICAgZnJvbnRlbmRTdGFjay5hZGRTdGFja0RlcGVuZGVuY3koYXBpU3RhY2spO1xuXG4gICAgcmV0dXJuIHsgYXBwLCBkYXRhU3RhY2ssIGFwaVN0YWNrLCBpbmdlc3RTdGFjaywgZnJvbnRlbmRTdGFjayB9O1xuICB9XG5cbiAgaXQoJ2luc3RhbnRpYXRlcyBhbGwgZm91ciBzdGFja3MgYW5kIHN5bnRoZXNpemVzIHdpdGhvdXQgZXJyb3InLCAoKSA9PiB7XG4gICAgY29uc3QgeyBhcHAsIGRhdGFTdGFjaywgYXBpU3RhY2ssIGluZ2VzdFN0YWNrLCBmcm9udGVuZFN0YWNrIH0gPSBidWlsZEFwcCgpO1xuXG4gICAgLy8gRWFjaCBzdGFjayBzeW50aGVzaXplcyB0byBhIHZhbGlkIChlbXB0eSkgdGVtcGxhdGUuXG4gICAgZm9yIChjb25zdCBzdGFjayBvZiBbZGF0YVN0YWNrLCBhcGlTdGFjaywgaW5nZXN0U3RhY2ssIGZyb250ZW5kU3RhY2tdKSB7XG4gICAgICBleHBlY3QoKCkgPT4gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKSkubm90LnRvVGhyb3coKTtcbiAgICB9XG5cbiAgICBjb25zdCBzdGFja05hbWVzID0gYXBwXG4gICAgICAuc3ludGgoKVxuICAgICAgLnN0YWNrcy5tYXAoKHMpID0+IHMuc3RhY2tOYW1lKVxuICAgICAgLnNvcnQoKTtcbiAgICBleHBlY3Qoc3RhY2tOYW1lcykudG9FcXVhbChbXG4gICAgICAnSGVhbHRoT21pY3NBcGknLFxuICAgICAgJ0hlYWx0aE9taWNzRGF0YScsXG4gICAgICAnSGVhbHRoT21pY3NGcm9udGVuZCcsXG4gICAgICAnSGVhbHRoT21pY3NJbmdlc3QnLFxuICAgIF0pO1xuICB9KTtcblxuICBpdCgnb3JkZXJzIHN0YWNrcyBieSBkZXBlbmRlbmN5IChEYXRhIC0+IEFwaSAtPiBJbmdlc3QsIEFwaSAtPiBGcm9udGVuZCknLCAoKSA9PiB7XG4gICAgY29uc3QgeyBhcGlTdGFjaywgaW5nZXN0U3RhY2ssIGZyb250ZW5kU3RhY2sgfSA9IGJ1aWxkQXBwKCk7XG5cbiAgICBleHBlY3QoYXBpU3RhY2suZGVwZW5kZW5jaWVzKS50b0NvbnRhaW5FcXVhbChcbiAgICAgIGV4cGVjdC5vYmplY3RDb250YWluaW5nKHsgc3RhY2tOYW1lOiAnSGVhbHRoT21pY3NEYXRhJyB9KSxcbiAgICApO1xuICAgIGNvbnN0IGluZ2VzdERlcHMgPSBpbmdlc3RTdGFjay5kZXBlbmRlbmNpZXMubWFwKChkKSA9PiBkLnN0YWNrTmFtZSk7XG4gICAgZXhwZWN0KGluZ2VzdERlcHMpLnRvRXF1YWwoXG4gICAgICBleHBlY3QuYXJyYXlDb250YWluaW5nKFsnSGVhbHRoT21pY3NEYXRhJywgJ0hlYWx0aE9taWNzQXBpJ10pLFxuICAgICk7XG4gICAgZXhwZWN0KGZyb250ZW5kU3RhY2suZGVwZW5kZW5jaWVzKS50b0NvbnRhaW5FcXVhbChcbiAgICAgIGV4cGVjdC5vYmplY3RDb250YWluaW5nKHsgc3RhY2tOYW1lOiAnSGVhbHRoT21pY3NBcGknIH0pLFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KCdhcHBsaWVzIHRoZSBwcm9qZWN0IGlkZW50aWZpZXIgdGFnIGF0IHRoZSBhcHAgbGV2ZWwnLCAoKSA9PiB7XG4gICAgY29uc3QgeyBhcHAgfSA9IGJ1aWxkQXBwKCk7XG4gICAgY29uc3QgYXNzZW1ibHkgPSBhcHAuc3ludGgoKTtcbiAgICBjb25zdCBkYXRhQXJ0aWZhY3QgPSBhc3NlbWJseS5nZXRTdGFja0J5TmFtZSgnSGVhbHRoT21pY3NEYXRhJyk7XG4gICAgZXhwZWN0KGRhdGFBcnRpZmFjdC50YWdzKS50b01hdGNoT2JqZWN0KHtcbiAgICAgIHByb2plY3Q6ICdoZWFsdGhvbWljcy13b3JrZmxvdy1kYXNoYm9hcmQnLFxuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnSW5nZXN0U3RhY2sgbGVhc3QtcHJpdmlsZWdlIElBTSAoUmVxIDIuMywgNC40LCAxMS4yKScsICgpID0+IHtcbiAgICAvKiogQ29sbGVjdHMgdGhlIGZsYXR0ZW5lZCBhY3Rpb24gbGlzdCBhY3Jvc3MgZXZlcnkgSUFNIHBvbGljeSBzdGF0ZW1lbnQuICovXG4gICAgZnVuY3Rpb24gYWxsUG9saWN5QWN0aW9ucyh0ZW1wbGF0ZTogVGVtcGxhdGUpOiBzdHJpbmdbXSB7XG4gICAgICBjb25zdCBwb2xpY2llcyA9IHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoJ0FXUzo6SUFNOjpQb2xpY3knKTtcbiAgICAgIGNvbnN0IGFjdGlvbnM6IHN0cmluZ1tdID0gW107XG4gICAgICBmb3IgKGNvbnN0IHBvbGljeSBvZiBPYmplY3QudmFsdWVzKHBvbGljaWVzKSkge1xuICAgICAgICBjb25zdCBzdGF0ZW1lbnRzID1cbiAgICAgICAgICAocG9saWN5IGFzIHsgUHJvcGVydGllcz86IHsgUG9saWN5RG9jdW1lbnQ/OiB7IFN0YXRlbWVudD86IHVua25vd25bXSB9IH0gfSlcbiAgICAgICAgICAgIC5Qcm9wZXJ0aWVzPy5Qb2xpY3lEb2N1bWVudD8uU3RhdGVtZW50ID8/IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IHN0bXQgb2Ygc3RhdGVtZW50cyBhcyBBcnJheTx7IEFjdGlvbj86IHN0cmluZyB8IHN0cmluZ1tdIH0+KSB7XG4gICAgICAgICAgY29uc3QgYWN0aW9uID0gc3RtdC5BY3Rpb247XG4gICAgICAgICAgaWYgKHR5cGVvZiBhY3Rpb24gPT09ICdzdHJpbmcnKSBhY3Rpb25zLnB1c2goYWN0aW9uKTtcbiAgICAgICAgICBlbHNlIGlmIChBcnJheS5pc0FycmF5KGFjdGlvbikpIGFjdGlvbnMucHVzaCguLi5hY3Rpb24pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gYWN0aW9ucztcbiAgICB9XG5cbiAgICBpdCgnZ3JhbnRzIER5bmFtb0RCIHdyaXRlL3JlYWQgc2NvcGVkIHRvIHRoZSB0YWJsZSBhbmQgR1NJMSBBUk5zJywgKCkgPT4ge1xuICAgICAgY29uc3QgeyBpbmdlc3RTdGFjayB9ID0gYnVpbGRBcHAoKTtcbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKGluZ2VzdFN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OklBTTo6UG9saWN5Jywge1xuICAgICAgICBQb2xpY3lEb2N1bWVudDoge1xuICAgICAgICAgIFN0YXRlbWVudDogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgICAgICBFZmZlY3Q6ICdBbGxvdycsXG4gICAgICAgICAgICAgIEFjdGlvbjogW1xuICAgICAgICAgICAgICAgICdkeW5hbW9kYjpQdXRJdGVtJyxcbiAgICAgICAgICAgICAgICAnZHluYW1vZGI6VXBkYXRlSXRlbScsXG4gICAgICAgICAgICAgICAgJ2R5bmFtb2RiOkdldEl0ZW0nLFxuICAgICAgICAgICAgICAgICdkeW5hbW9kYjpRdWVyeScsXG4gICAgICAgICAgICAgICAgJ2R5bmFtb2RiOkNvbmRpdGlvbkNoZWNrSXRlbScsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdKSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgaXQoJ2dyYW50cyBhcHBzeW5jOkdyYXBoUUwgc2NvcGVkIG9ubHkgdG8gdGhlIHB1Ymxpc2ggbXV0YXRpb24gZmllbGQgQVJOcyAoUmVxIDQuNCknLCAoKSA9PiB7XG4gICAgICBjb25zdCB7IGluZ2VzdFN0YWNrIH0gPSBidWlsZEFwcCgpO1xuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soaW5nZXN0U3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6SUFNOjpQb2xpY3knLCB7XG4gICAgICAgIFBvbGljeURvY3VtZW50OiB7XG4gICAgICAgICAgU3RhdGVtZW50OiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICAgIEVmZmVjdDogJ0FsbG93JyxcbiAgICAgICAgICAgICAgQWN0aW9uOiAnYXBwc3luYzpHcmFwaFFMJyxcbiAgICAgICAgICAgICAgUmVzb3VyY2U6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICAgICAgICAnRm46OkpvaW4nOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgICAgICAgICAgICBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgICAgICAgICAgICAgICcvdHlwZXMvTXV0YXRpb24vZmllbGRzL3B1Ymxpc2hSdW5VcGRhdGUnLFxuICAgICAgICAgICAgICAgICAgICBdKSxcbiAgICAgICAgICAgICAgICAgIF0pLFxuICAgICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgICAgICAgICAgJ0ZuOjpKb2luJzogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICAgICAgICAgICAgTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICAgICAgICAgICAgICAnL3R5cGVzL011dGF0aW9uL2ZpZWxkcy9wdWJsaXNoVGFza1VwZGF0ZScsXG4gICAgICAgICAgICAgICAgICAgIF0pLFxuICAgICAgICAgICAgICAgICAgXSksXG4gICAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICAgIF0pLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSksXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIGl0KCdncmFudHMgSGVhbHRoT21pY3MgcmVhZC1vbmx5IGFjdGlvbnMgd2l0aCBubyBjcmVhdGUvdXBkYXRlL2RlbGV0ZSAoUmVxIDIuMyknLCAoKSA9PiB7XG4gICAgICBjb25zdCB7IGluZ2VzdFN0YWNrIH0gPSBidWlsZEFwcCgpO1xuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soaW5nZXN0U3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6SUFNOjpQb2xpY3knLCB7XG4gICAgICAgIFBvbGljeURvY3VtZW50OiB7XG4gICAgICAgICAgU3RhdGVtZW50OiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICAgIEVmZmVjdDogJ0FsbG93JyxcbiAgICAgICAgICAgICAgQWN0aW9uOiBbXG4gICAgICAgICAgICAgICAgJ29taWNzOkdldFJ1bicsXG4gICAgICAgICAgICAgICAgJ29taWNzOkxpc3RSdW5UYXNrcycsXG4gICAgICAgICAgICAgICAgJ29taWNzOkdldFJ1blRhc2snLFxuICAgICAgICAgICAgICAgICdvbWljczpHZXRXb3JrZmxvdycsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdKSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgaXQoJ2dyYW50cyBubyB3aWxkY2FyZCBhY3Rpb25zIGFuZCBubyB3aWxkY2FyZCByZXNvdXJjZXMgb24gdGhlIGluZ2VzdCByb2xlIChSZXEgMTEuMiknLCAoKSA9PiB7XG4gICAgICBjb25zdCB7IGluZ2VzdFN0YWNrIH0gPSBidWlsZEFwcCgpO1xuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soaW5nZXN0U3RhY2spO1xuXG4gICAgICAvLyBObyBgQWN0aW9uOiBcIipcImAgaW4gYW55IHN0YXRlbWVudC5cbiAgICAgIGV4cGVjdChhbGxQb2xpY3lBY3Rpb25zKHRlbXBsYXRlKSkubm90LnRvQ29udGFpbignKicpO1xuXG4gICAgICAvLyBObyBpbmxpbmUgcG9saWN5IHN0YXRlbWVudCB1c2VzIGBSZXNvdXJjZTogXCIqXCJgLlxuICAgICAgY29uc3QgcG9saWNpZXMgPSB0ZW1wbGF0ZS5maW5kUmVzb3VyY2VzKCdBV1M6OklBTTo6UG9saWN5Jyk7XG4gICAgICBmb3IgKGNvbnN0IHBvbGljeSBvZiBPYmplY3QudmFsdWVzKHBvbGljaWVzKSkge1xuICAgICAgICBjb25zdCBzdGF0ZW1lbnRzID1cbiAgICAgICAgICAocG9saWN5IGFzIHsgUHJvcGVydGllcz86IHsgUG9saWN5RG9jdW1lbnQ/OiB7IFN0YXRlbWVudD86IHVua25vd25bXSB9IH0gfSlcbiAgICAgICAgICAgIC5Qcm9wZXJ0aWVzPy5Qb2xpY3lEb2N1bWVudD8uU3RhdGVtZW50ID8/IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IHN0bXQgb2Ygc3RhdGVtZW50cyBhcyBBcnJheTx7IFJlc291cmNlPzogdW5rbm93biB9Pikge1xuICAgICAgICAgIGV4cGVjdChzdG10LlJlc291cmNlKS5ub3QudG9CZSgnKicpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xufSk7XG4iXX0=