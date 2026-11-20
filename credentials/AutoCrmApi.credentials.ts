import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

export class AutoCrmApi implements ICredentialType {
	name = 'autoCrmApi';

	// The brand is officially spelled lowercase, but n8n's community node scan
	// requires title case for credential display names
	displayName = 'Autocrm API';

	// Kept next to this file because credential icons resolve relative to it
	icon: Icon = 'file:autocrm.svg';

	// The official API3 documentation (PDF) is not public; this points to the vendor page
	documentationUrl = 'https://www.autocrm.de/';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://www.autocrm.de/api/api3',
			required: true,
			description:
				'Endpoint of the autocrm API3. Keep the default unless autocrm support tells you otherwise. HTTP 308 redirects to another subdomain are followed automatically by the node.',
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
			description: 'Username of the API user (provided by autocrm support)',
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Password of the API user',
		},
		{
			displayName:
				'autocrm allows only one request at a time per API user. Use a dedicated API user for this n8n instance and avoid using the same credentials from other systems in parallel.',
			name: 'serializationNotice',
			type: 'notice',
			default: '',
		},
		// Defaults are the standard limits of the API3 specification; keep them in sync
		// with RATE_LIMITS in AutoCrm.node.ts, which falls back to the same values
		{
			displayName:
				'Throughput limits of this API user in requests per 60 seconds. The defaults are the autocrm standard; enter the values autocrm agreed with you if they differ. The node waits before a request that would exceed a limit. 0 turns the waiting off for that operation.',
			name: 'rateLimitNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Create Limit',
			name: 'rateLimitCreate',
			type: 'number',
			typeOptions: { minValue: 0, numberPrecision: 0 },
			default: 3,
			description: 'Requests per 60 seconds for Create. autocrm standard: 3.',
		},
		{
			displayName: 'Search Limit',
			name: 'rateLimitSearch',
			type: 'number',
			typeOptions: { minValue: 0, numberPrecision: 0 },
			default: 4,
			description: 'Requests per 60 seconds for Search. autocrm standard: 4.',
		},
		{
			displayName: 'Assign Limit',
			name: 'rateLimitAssign',
			type: 'number',
			typeOptions: { minValue: 0, numberPrecision: 0 },
			default: 5,
			description: 'Requests per 60 seconds for Assign. autocrm standard: 5.',
		},
		{
			displayName: 'Attach Email Limit',
			name: 'rateLimitAttachEmail',
			type: 'number',
			typeOptions: { minValue: 0, numberPrecision: 0 },
			default: 5,
			description: 'Requests per 60 seconds for Attach Email. autocrm standard: 5.',
		},
		{
			displayName: 'Add Note Limit',
			name: 'rateLimitAddNote',
			type: 'number',
			typeOptions: { minValue: 0, numberPrecision: 0 },
			default: 5,
			description: 'Requests per 60 seconds for Add Note. autocrm standard: 5.',
		},
		{
			displayName: 'Exists Limit',
			name: 'rateLimitExists',
			type: 'number',
			typeOptions: { minValue: 0, numberPrecision: 0 },
			default: 150,
			description:
				'Requests per 60 seconds for Exists, also used by the credential test. autocrm standard: 150.',
		},
		{
			displayName: 'Get Limit',
			name: 'rateLimitGet',
			type: 'number',
			typeOptions: { minValue: 0, numberPrecision: 0 },
			default: 150,
			description: 'Requests per 60 seconds for Get. autocrm standard: 150.',
		},
	];
}
