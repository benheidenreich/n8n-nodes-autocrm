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
	];
}
