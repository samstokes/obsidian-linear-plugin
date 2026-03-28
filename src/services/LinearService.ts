import { LinearClient, Issue, Team, WorkflowState, LinearRawResponse } from "@linear/sdk";
import { Notice } from "obsidian";
import { LinearPluginSettings } from '../settings';

interface WorkflowStateNode {
    id: string;
    name: string;
    type: string;
    position: number;
    team?: {
        id: string;
        name: string;
    };
}

interface WorkflowStateQueryResponse {
    workflowStates: {
        nodes: WorkflowStateNode[];
        pageInfo: {
            hasNextPage: boolean;
            endCursor: string;
        };
    };
}

export interface IssueOptions {
    limit?: number;
    teamName?: string;
    status?: string[];
    assigneeEmail?: string;
    sorting?: {
        field: 'priority' | 'status' | 'date';
        direction: 'asc' | 'desc';
    };
    hideDescription?: boolean;
    cycle?: 'current';
}

export class LinearService {
    private client: LinearClient | null = null;
    private teamCache: Map<string, string> = new Map(); // name -> id mapping
    private workflowStatesCache: {
        timestamp: number;
        states: WorkflowStateNode[];
    } | null = null;
    private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

    constructor(private settings: LinearPluginSettings) {
        if (settings.apiKey) {
            this.client = new LinearClient({ apiKey: settings.apiKey });
            this.log('Service initialized with API key');
        } else {
            this.log('Service initialized without API key');
        }
    }

    private log(message: string, data?: any, isError: boolean = false) {
        if (!this.settings.debugMode) return;
        
        const prefix = '🔄 Linear Plugin: ';
        if (isError) {
            console.error(prefix + message, data);
        } else {
            console.log(prefix + message, data || '');
        }
    }

    private async ensureClient(): Promise<LinearClient> {
        if (!this.settings.apiKey) {
            throw new Error("Linear API key not configured");
        }

        if (!this.client) {
            this.client = new LinearClient({ apiKey: this.settings.apiKey });
            this.log('Created new Linear client');
        }

        return this.client;
    }

    async getTeams(): Promise<Team[]> {
        try {
            this.log('Fetching teams...');
            const client = await this.ensureClient();
            const { nodes } = await client.teams();
            this.log('Teams fetched:', nodes.map(t => ({ id: t.id, name: t.name })));
            return nodes;
        } catch (error) {
            this.log('Failed to fetch teams - API error', error, true);
            throw new Error("Failed to fetch teams");
        }
    }

    private async getTeamIdByName(teamName: string): Promise<string | null> {
        this.log(`Looking for team: "${teamName}"`);
        
        // Check cache first
        const normalizedTeamName = teamName.toLowerCase();
        if (this.teamCache.has(normalizedTeamName)) {
            const cachedId = this.teamCache.get(normalizedTeamName);
            this.log(`Found team "${teamName}" in cache with ID: ${cachedId}`);
            return cachedId || null;
        }
        
        try {
            const teams = await this.getTeams();
            for (const team of teams) {
                const name = team.name.toLowerCase();
                if (name === normalizedTeamName) {
                    // Cache the found team
                    this.teamCache.set(normalizedTeamName, team.id);
                    this.log(`Found team "${teamName}" with ID: ${team.id}`);
                    return team.id;
                }
            }
            this.log(`Team "${teamName}" not found`);
            return null;
        } catch (error) {
            this.log('Failed to find team - API error', error, true);
            return null;
        }
    }

    private isCacheValid(): boolean {
        return !!(
            this.workflowStatesCache &&
            Date.now() - this.workflowStatesCache.timestamp < this.CACHE_TTL
        );
    }

    async getWorkflowStates(): Promise<WorkflowStateNode[]> {
        try {
            // Check cache first
            if (this.isCacheValid()) {
                this.log('Using cached workflow states');
                return this.workflowStatesCache!.states;
            }

            this.log('Fetching workflow states...');
            const client = await this.ensureClient();
            let allStates: WorkflowStateNode[] = [];
            let hasNextPage = true;
            let after: string | null = null;

            while (hasNextPage) {
                const response: LinearRawResponse<WorkflowStateQueryResponse> = await client.client.rawRequest<WorkflowStateQueryResponse, { after?: string }>(`
                    query WorkflowStates${after ? '($after: String!)' : ''} {
                        workflowStates(first: 100${after ? ', after: $after' : ''}) {
                            nodes {
                                id
                                name
                                type
                                position
                                team {
                                    id
                                    name
                                }
                            }
                            pageInfo {
                                hasNextPage
                                endCursor
                            }
                        }
                    }
                `, after ? { after } : undefined);

                if (!response?.data?.workflowStates?.nodes) {
                    throw new Error("No workflow states returned from query");
                }

                const { nodes, pageInfo } = response.data.workflowStates;
                allStates = allStates.concat(nodes);
                hasNextPage = pageInfo.hasNextPage;
                after = pageInfo.endCursor;

                this.log(`Fetched ${nodes.length} workflow states${hasNextPage ? ', fetching more...' : ''}`);
            }

            // Update cache
            this.workflowStatesCache = {
                timestamp: Date.now(),
                states: allStates
            };

            this.log('All workflow states fetched:', allStates.map(s => ({
                id: s.id,
                name: s.name,
                team: s.team ? `${s.team.name} (${s.team.id})` : 'no team'
            })));
            
            return allStates;
        } catch (error) {
            this.log('Error fetching workflow states', error);
            throw new Error("Failed to fetch workflow states");
        }
    }

    private async getStatusByName(statusName: string, teamId?: string): Promise<WorkflowState | null> {
        this.log(`Looking for status: "${statusName}"${teamId ? ` in team ID: ${teamId}` : ''}`);

        try {
            const states = await this.getWorkflowStates();
            const normalizedSearchName = this.normalizeStateName(statusName);

            for (const state of states) {
                const normalizedStateName = this.normalizeStateName(state.name);

                this.log(`Checking state: "${state.name}" (${state.id})`, {
                    matches: {
                        name: normalizedStateName === normalizedSearchName,
                        team: !teamId || !state.team || state.team.id === teamId
                    },
                    state: {
                        name: state.name,
                        normalizedName: normalizedStateName,
                        id: state.id,
                        team: state.team ? `${state.team.name} (${state.team.id})` : 'no team'
                    }
                });

                if (normalizedStateName === normalizedSearchName &&
                    (!teamId || !state.team || state.team.id === teamId)) {
                    this.log(`Found matching state: "${state.name}"`);
                    return state as unknown as WorkflowState;
                }
            }

            this.log(`No matching state found for "${statusName}"`);
            return null;
        } catch (error) {
            this.log('Error finding status', error);
            return null;
        }
    }

    private async getStatusIdsByName(statusName: string, teamId?: string): Promise<string[]> {
        this.log(`Looking for all status IDs matching: "${statusName}"${teamId ? ` in team ID: ${teamId}` : ''}`);

        try {
            const states = await this.getWorkflowStates();
            const normalizedSearchName = this.normalizeStateName(statusName);
            const matchingIds: string[] = [];

            for (const state of states) {
                const normalizedStateName = this.normalizeStateName(state.name);
                if (normalizedStateName === normalizedSearchName &&
                    (!teamId || !state.team || state.team.id === teamId)) {
                    matchingIds.push(state.id);
                }
            }

            this.log(`Found ${matchingIds.length} matching state IDs for "${statusName}":`, matchingIds);
            return matchingIds;
        } catch (error) {
            this.log('Error finding status IDs', error);
            return [];
        }
    }

    private normalizeStateName(name: string): string {
        return name.toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    private buildSort(sorting?: IssueOptions['sorting']): any[] | undefined {
        if (!sorting || sorting.field === 'status') return undefined;
        const order = sorting.direction === 'asc' ? 'Ascending' : 'Descending';
        switch (sorting.field) {
            case 'priority':
                return [{ priority: { order, noPriorityFirst: false } }];
            case 'date':
                return [{ dueDate: { order, nulls: 'last' } }];
        }
    }

    private async sortByStatus(nodes: Issue[], direction: 'asc' | 'desc'): Promise<Issue[]> {
        const states = await this.getWorkflowStates();
        const positionById = new Map(states.map(s => [s.id, s.position]));

        return [...nodes].sort((a, b) => {
            const posA = positionById.get(a.stateId ?? '') ?? Infinity;
            const posB = positionById.get(b.stateId ?? '') ?? Infinity;
            return direction === 'asc' ? posA - posB : posB - posA;
        });
    }

    async getIssues(options?: IssueOptions): Promise<Issue[]> {
        try {
            this.log('Getting issues with options:', options);
            
            const client = await this.ensureClient();
            let teamId: string | undefined = undefined;
            const filter: any = {};

            if (options?.teamName) {
                const fetchedTeamId = await this.getTeamIdByName(options.teamName);
                if (!fetchedTeamId) {
                    this.log(`Team "${options.teamName}" not found - skipping query`);
                    new Notice(`Team "${options.teamName}" not found`);
                    return [];
                }
                teamId = fetchedTeamId;
                filter.team = { id: { eq: teamId } };
                this.log(`Added team filter:`, filter.team);
            }

            if (options?.status?.length) {
                const allStateIds: string[] = [];
                const notFound: string[] = [];
                for (const statusName of options.status) {
                    const ids = await this.getStatusIdsByName(statusName, teamId);
                    if (ids.length === 0) {
                        notFound.push(statusName);
                    } else {
                        allStateIds.push(...ids);
                    }
                }
                if (notFound.length > 0) {
                    const message = `Status ${notFound.map(s => `"${s}"`).join(', ')} not found${teamId ? ' for the specified team' : ''}`;
                    this.log(message);
                    new Notice(message);
                }
                if (allStateIds.length === 0) {
                    return [];
                }
                if (allStateIds.length === 1) {
                    filter.state = { id: { eq: allStateIds[0] } };
                } else {
                    filter.state = { id: { in: allStateIds } };
                }
                this.log(`Added status filter:`, filter.state);
            }

            if (options?.assigneeEmail) {
                filter.assignee = { email: { eq: options.assigneeEmail } };
                this.log(`Added assignee filter:`, filter.assignee);
            }

            if (options?.cycle === 'current') {
                if (!options.teamName && !options.assigneeEmail) {
                    const message = 'Cycle filter requires a team or assignee to be specified';
                    this.log(message);
                    new Notice(message);
                    return [];
                }
                filter.cycle = { isActive: { eq: true } };
                this.log(`Added cycle filter: current (active)`);
            }

            const sort = this.buildSort(options?.sorting);
            this.log('Fetching issues with filter:', { filter, sort });
            let { nodes } = await client.issues({
                first: options?.limit,
                filter: Object.keys(filter).length > 0 ? filter : undefined,
                sort,
            });

            if (options?.sorting?.field === 'status') {
                nodes = await this.sortByStatus(nodes, options.sorting.direction);
            }

            // Enhanced logging for issue details
            for (const issue of nodes) {
                const assignee = issue.assignee ? await issue.assignee : null;
                this.log(`Issue details:`, {
                    id: issue.id,
                    identifier: issue.identifier,
                    title: issue.title,
                    dueDate: issue.dueDate,
                    formattedDueDate: issue.dueDate ? new Date(issue.dueDate + 'T00:00:00').toLocaleDateString() : 'No due date',
                    assignee: assignee ? {
                        id: assignee.id,
                        name: assignee.name,
                        email: assignee.email
                    } : 'Unassigned'
                });
            }
            
            this.log(`Found ${nodes.length} issues`);
            return nodes;
        } catch (error) {
            this.log('Failed to fetch Linear issues - API error', error, true);
            new Notice("Failed to fetch Linear issues");
            return [];
        }
    }

    async getIssueById(issueId: string): Promise<Issue | null> {
        try {
            this.log(`Fetching issue by ID: ${issueId}`);
            const client = await this.ensureClient();
            const issue = await client.issue(issueId);
            if (!issue) {
                this.log(`No issue found for ID: ${issueId}`);
                new Notice(`No Linear issue found for ID: ${issueId}`);
                return null;
            }
            this.log('Fetched issue:', issue);
            return issue;
        } catch (error) {
            this.log('Failed to fetch Linear issue by ID - API error', error, true);
            new Notice(`Failed to fetch Linear issue for ID: ${issueId}`);
            return null;
        }
    }
} 