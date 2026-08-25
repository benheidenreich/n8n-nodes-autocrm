import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import type { AutoCrmCredentials } from './transport';
import { AutoCrmApiError, autoCrmRequest, MAX_BASE64_CHARS } from './transport';

async function autoCrmApiCall(
	this: IExecuteFunctions,
	functionName: string,
	data: IDataObject,
	itemIndex: number,
): Promise<IDataObject> {
	const rawCredentials = await this.getCredentials('autoCrmApi');
	const credentials: AutoCrmCredentials = {
		baseUrl: String(rawCredentials.baseUrl ?? ''),
		username: String(rawCredentials.username ?? ''),
		password: String(rawCredentials.password ?? ''),
	};
	try {
		return await autoCrmRequest(credentials, functionName, data);
	} catch (error) {
		if (error instanceof AutoCrmApiError) {
			throw new NodeApiError(this.getNode(), { message: error.message } as JsonObject, {
				message: error.message,
				description: error.description,
				httpCode: error.httpStatus !== undefined ? String(error.httpStatus) : undefined,
				itemIndex,
			});
		}
		throw error;
	}
}

// autocrm timestamps are Text(19) like "2021-06-22 14:33:21" in German local time (CET/CEST)
const berlinTimestampFormatter = new Intl.DateTimeFormat('sv-SE', {
	timeZone: 'Europe/Berlin',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hourCycle: 'h23',
});

function toApiTimestamp(node: INode, itemIndex: number, label: string, value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new NodeOperationError(node, `"${label}" is not a valid date: ${value}`, { itemIndex });
	}
	return berlinTimestampFormatter.format(date).replace('T', ' ');
}

// autocrm phone numbers: leading +, country code, 8-20 digits, no separators
function normalizePhoneNumber(
	node: INode,
	itemIndex: number,
	label: string,
	value: string,
): string {
	let normalized = value.replace(/[\s\-/().]/g, '');
	if (normalized.startsWith('00')) normalized = `+${normalized.slice(2)}`;
	if (!/^\+\d{8,20}$/.test(normalized)) {
		throw new NodeOperationError(
			node,
			`"${label}" must be an international phone number like +496301708123456 (8-20 digits after the leading +)`,
			{ itemIndex, description: `Received: ${value}` },
		);
	}
	return normalized;
}

// The spec forbids empty strings in present fields — omit them instead
function pruneEmpty(input: IDataObject): IDataObject {
	const result: IDataObject = {};
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || value === null) continue;
		if (typeof value === 'string' && value.trim() === '') continue;
		result[key] = value;
	}
	return result;
}

function assertBase64Size(node: INode, itemIndex: number, chars: number, context: string): void {
	if (chars > MAX_BASE64_CHARS) {
		const megabytes = (chars / (1024 * 1024)).toFixed(1);
		throw new NodeOperationError(
			node,
			`${context} exceeds the autocrm limit of 50 MB of base64-encoded data (got ${megabytes} MB)`,
			{
				itemIndex,
				description:
					'Reduce the file size. Note that base64 encoding increases the size by about a third.',
			},
		);
	}
}

function getRequiredString(
	context: IExecuteFunctions,
	parameterName: string,
	label: string,
	itemIndex: number,
): string {
	const value = String(context.getNodeParameter(parameterName, itemIndex) ?? '').trim();
	if (value === '') {
		throw new NodeOperationError(context.getNode(), `"${label}" must not be empty`, { itemIndex });
	}
	return value;
}

function getLeadId(context: IExecuteFunctions, itemIndex: number): number {
	const raw = context.getNodeParameter('leadId', itemIndex);
	const value = typeof raw === 'number' ? raw : Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new NodeOperationError(
			context.getNode(),
			`Lead ID must be a positive whole number, got "${String(raw)}"`,
			{ itemIndex },
		);
	}
	return value;
}

// n8n parameter name -> autocrm field name for the contact object
const CONTACT_FIELD_MAP: Record<string, string> = {
	city: 'ort',
	company: 'firma',
	country: 'land',
	customerNumber: 'kundennummer',
	fax: 'fax',
	firstName: 'vorname',
	licensePlate: 'kfz-kennzeichen',
	mobile: 'mobil',
	phone: 'telefon',
	postalCode: 'plz',
	salutation: 'anrede',
	street: 'strasse',
	title: 'titel',
};

const PHONE_FIELD_LABELS: Record<string, string> = {
	fax: 'Fax',
	mobile: 'Mobile',
	phone: 'Phone',
};

export class AutoCrm implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'autocrm',
		name: 'autoCrm',
		icon: 'file:autocrm.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Create, assign and enrich leads in autocrm',
		defaults: {
			name: 'autocrm',
		},
		usableAsTool: true,
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'autoCrmApi',
				required: true,
				testedBy: 'autoCrmApiTest',
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Lead',
						value: 'lead',
					},
				],
				default: 'lead',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['lead'],
					},
				},
				options: [
					{
						name: 'Add Note',
						value: 'addNote',
						description: 'Add a note, optionally with attachments, to the history of a lead',
						action: 'Add a note to a lead',
					},
					{
						name: 'Assign',
						value: 'assign',
						description: 'Assign a lead to a branch, category and employee or team',
						action: 'Assign a lead',
					},
					{
						name: 'Attach Email',
						value: 'attachEmail',
						description:
							'Archive an already sent or received email (.eml) in the history of a lead — nothing is sent',
						action: 'Attach an email to a lead',
					},
					{
						name: 'Create',
						value: 'create',
						description: 'Create a new lead together with its contact',
						action: 'Create a lead',
					},
					{
						name: 'Exists',
						value: 'exists',
						description: 'Check whether a lead exists and where it was merged to',
						action: 'Check whether a lead exists',
					},
				],
				default: 'create',
			},

			// ----------------------------------
			//     shared: lead ID
			// ----------------------------------
			{
				displayName: 'Lead ID',
				name: 'leadId',
				type: 'number',
				required: true,
				default: 0,
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['addNote', 'assign', 'attachEmail', 'exists'],
					},
				},
				// eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-id -- "id-anfrage" is the literal autocrm field name
				description:
					'Numeric ID of the lead in autocrm, as returned in "id-anfrage" by the Create operation',
			},

			// ----------------------------------
			//     lead: create
			// ----------------------------------
			{
				displayName: 'Contact ID',
				name: 'contactId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['create'],
					},
				},
				// eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-id -- "x-id-kontakt" is the literal autocrm field name
				description:
					'Unique ID of the contact in YOUR system (autocrm field "x-id-kontakt"). Acts as an upsert key: if autocrm already knows a contact with this ID, the lead is attached to that contact and all other contact fields are ignored (except License Plate). Check "neuer-kontakt" in the output to see whether a new contact was created.',
			},
			{
				displayName: 'Last Name',
				name: 'lastName',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['create'],
					},
				},
				description: 'Last name of the contact',
			},
			{
				displayName: 'Email',
				name: 'email',
				type: 'string',
				placeholder: 'name@email.com',
				default: '',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['create'],
					},
				},
				description:
					'Email address of the contact. autocrm requires at least one of Email, Phone or Mobile — Phone and Mobile are available under Additional Contact Fields.',
			},
			{
				displayName: 'Branch ID',
				name: 'branchId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['create'],
					},
				},
				description:
					'ID of the autocrm branch (Niederlassung) the lead is assigned to. The valid values are tenant-specific — ask autocrm support.',
			},
			{
				displayName: 'Category',
				name: 'category',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. PARENT|CHILD',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['create'],
					},
				},
				description:
					'Name of the autocrm category, or its path in the hierarchy separated by "|". The path can be omitted when the name is unambiguous. The category decides whether the lead is a vehicle lead.',
			},
			{
				displayName: 'First Contact Channel',
				name: 'firstContactChannel',
				type: 'options',
				options: [
					{
						name: 'Email',
						value: 'E-Mail',
					},
					{
						name: 'Letter',
						value: 'Brief',
					},
					{
						name: 'Outbound',
						value: 'Outbound',
					},
					{
						name: 'Phone',
						value: 'Telefon',
					},
					{
						name: 'Showroom',
						value: 'Verkaufsraum',
					},
				],
				default: 'E-Mail',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['create'],
					},
				},
				description: 'How the customer first got in contact (autocrm field "erstkontakt")',
			},
			{
				displayName: 'Source',
				name: 'source',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. Homepage',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['create'],
					},
				},
				description:
					'Source of the lead (autocrm field "quelle"). The valid values are tenant-specific — ask autocrm support.',
			},
			{
				displayName: 'Note Title',
				name: 'noteTitle',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['addNote', 'create'],
					},
				},
				description: 'Title of the history note',
			},
			{
				displayName: 'Note Content',
				name: 'noteContent',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['addNote', 'create'],
					},
				},
				description: 'Text of the history note, for example the customer message',
			},
			{
				displayName: 'Additional Contact Fields',
				name: 'additionalContactFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['create'],
					},
				},
				description:
					'Further contact fields. They are only used when autocrm creates a NEW contact for the given Contact ID (exception: License Plate).',
				options: [
					{
						displayName: 'City',
						name: 'city',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Company',
						name: 'company',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Country',
						name: 'country',
						type: 'string',
						default: '',
						placeholder: 'e.g. DE',
						description: 'Two-letter country code (ISO 3166-1 alpha-2)',
					},
					{
						displayName: 'Customer Number',
						name: 'customerNumber',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Fax',
						name: 'fax',
						type: 'string',
						default: '',
						description: 'Fax number in international format, for example +496301708123456',
					},
					{
						displayName: 'First Name',
						name: 'firstName',
						type: 'string',
						default: '',
					},
					{
						displayName: 'License Plate',
						name: 'licensePlate',
						type: 'string',
						default: '',
						placeholder: 'e.g. KL AB 123',
						description:
							'License plate of the contact. This is the only contact field that autocrm also applies when the contact already exists.',
					},
					{
						displayName: 'Mobile',
						name: 'mobile',
						type: 'string',
						default: '',
						description: 'Mobile number in international format, for example +49170123456789',
					},
					{
						displayName: 'Phone',
						name: 'phone',
						type: 'string',
						default: '',
						description: 'Phone number in international format, for example +496301708123456',
					},
					{
						displayName: 'Postal Code',
						name: 'postalCode',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Salutation',
						name: 'salutation',
						type: 'options',
						options: [
							{
								name: 'Mr',
								value: 'Herr',
							},
							{
								name: 'Ms',
								value: 'Frau',
							},
							{
								name: 'None',
								value: 'keine',
							},
						],
						default: 'keine',
					},
					{
						displayName: 'Street',
						name: 'street',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Title',
						name: 'title',
						type: 'string',
						default: '',
						placeholder: 'e.g. Dr.',
					},
				],
			},
			{
				displayName: 'Additional Lead Fields',
				name: 'additionalLeadFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['create'],
					},
				},
				options: [
					{
						displayName: 'Assignee Email',
						name: 'assigneeEmail',
						type: 'string',
						placeholder: 'name@email.com',
						default: '',
						description:
							'The AUTOCRM login email address of the employee who should process the lead. Careful: the Assign operation expects the external dealership address instead.',
					},
					{
						displayName: 'Close By',
						name: 'closeBy',
						type: 'dateTime',
						default: '',
						description: 'Deadline for closing the lead',
					},
					{
						displayName: 'External Lead ID',
						name: 'externalLeadId',
						type: 'string',
						default: '',
						// eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-id -- "x-id-anfrage" is the literal autocrm field name
						description: 'ID of the lead in your own system (autocrm field "x-id-anfrage")',
					},
					{
						displayName: 'External Lead ID Type',
						name: 'externalLeadIdType',
						type: 'string',
						default: '',
						description:
							'Type of the external lead ID. Known values: GCLID (Google Click Identifier), FBCLID (Facebook Click Identifier), FD (financing service). Only allowed together with External Lead ID.',
					},
					{
						displayName: 'Lead Title',
						name: 'leadTitle',
						type: 'string',
						default: '',
						description:
							'Title of the lead. If empty, autocrm uses the title of the first note. For vehicle leads the title is determined automatically and this field is ignored.',
					},
					{
						displayName: 'Offer Price',
						name: 'offerPrice',
						type: 'number',
						default: 0,
						description:
							'Individual offer price for the vehicle in EUR (autocrm rounds to whole euros)',
					},
					{
						displayName: 'Process By',
						name: 'processBy',
						type: 'dateTime',
						default: '',
						description: 'Deadline for processing the lead',
					},
					{
						displayName: 'Process From',
						name: 'processFrom',
						type: 'dateTime',
						default: '',
						description: 'Earliest time the lead should be processed',
					},
					{
						displayName: 'Remarks',
						name: 'remarks',
						type: 'string',
						typeOptions: {
							rows: 3,
						},
						default: '',
						description: 'Content of the yellow remarks field of the lead',
					},
					{
						displayName: 'Status',
						name: 'status',
						type: 'options',
						options: [
							{
								name: 'In Progress',
								value: 'in Bearbeitung',
							},
							{
								name: 'Open',
								value: 'offen',
							},
						],
						default: 'offen',
						description: 'Initial status of the lead',
					},
				],
			},
			{
				displayName: 'Vehicle',
				name: 'vehicle',
				type: 'collection',
				placeholder: 'Add Vehicle Field',
				default: {},
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['create'],
					},
				},
				description:
					'Vehicle the customer asks about. Only allowed for categories configured as vehicle leads in autocrm; must be omitted for LMS leads. When used, both fields are required.',
				options: [
					{
						displayName: 'Description',
						name: 'description',
						type: 'string',
						default: '',
						description:
							'Free-text description of the vehicle: make, model, first registration, mileage, price, listing URL. Shown in autocrm if the vehicle is not found by its ID.',
					},
					{
						displayName: 'Vehicle ID',
						name: 'vehicleId',
						type: 'string',
						default: '',
						// eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-id -- "x-id-fahrzeug" is the literal autocrm field name
						description:
							'ID of the vehicle in your own system (autocrm field "x-id-fahrzeug"). If autocrm already knows this ID, the existing vehicle is linked and Description is ignored.',
					},
				],
			},

			// ----------------------------------
			//     lead: assign
			// ----------------------------------
			{
				displayName: 'Assign To',
				name: 'assignTo',
				type: 'options',
				options: [
					{
						name: 'Employee',
						value: 'employee',
						description: 'Assign to a specific employee identified by their external email address',
					},
					{
						name: 'Team',
						value: 'team',
						description: 'Assign to the responsible team of the branch and category',
					},
				],
				default: 'employee',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['assign'],
					},
				},
			},
			{
				displayName: 'Employee Email',
				name: 'employeeEmail',
				type: 'string',
				placeholder: 'name@email.com',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['assign'],
						assignTo: ['employee'],
					},
				},
				description:
					'The EXTERNAL email address of the employee at the dealership — not the autocrm login address. Must match exactly one employee who is a valid assignee for the branch and category of the lead.',
			},
			{
				displayName: 'Branch ID',
				name: 'branchId',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['assign'],
					},
				},
				description: 'ID of the branch to move the lead to. Leave empty to keep the current branch.',
			},
			{
				displayName: 'Category',
				name: 'category',
				type: 'string',
				default: '',
				placeholder: 'e.g. PARENT|CHILD',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['assign'],
					},
				},
				description:
					'Name or path (separated by "|") of the category to move the lead to. Leave empty to keep the current category.',
			},
			{
				displayName:
					'The lead is always (re)assigned: either to the given employee, or — with "Team" — to the team responsible for the branch and category. autocrm may pick a substitute employee. This operation assigns the lead to an assignee; it does not link emails to leads.',
				name: 'assignNotice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['assign'],
					},
				},
			},

			// ----------------------------------
			//     lead: attach email
			// ----------------------------------
			{
				displayName: 'Input Mode',
				name: 'emlSource',
				type: 'options',
				options: [
					{
						name: 'Binary File',
						value: 'binary',
						description: 'Take the .eml file from a binary field of the input item',
					},
					{
						name: 'Raw EML Text',
						value: 'raw',
						description: 'Provide the raw RFC 822 message text; the node base64-encodes it',
					},
				],
				default: 'binary',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['attachEmail'],
					},
				},
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				required: true,
				default: 'data',
				hint: 'The name of the input binary field containing the .eml file',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['attachEmail'],
						emlSource: ['binary'],
					},
				},
			},
			{
				displayName: 'EML Text',
				name: 'emlText',
				type: 'string',
				typeOptions: {
					rows: 6,
				},
				default: '',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['attachEmail'],
						emlSource: ['raw'],
					},
				},
				description:
					'Complete raw email in RFC 822 format: headers, blank line, body. Should contain at least the MIME-Version, Content-Type, From, To, Date and Subject headers.',
			},
			{
				displayName:
					'This operation only archives the email in the lead history — nothing is sent. Send the email first (for example with the Send Email node), then attach it here. autocrm cannot read S/MIME-encrypted emails. Maximum size: 50 MB.',
				name: 'attachEmailNotice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['attachEmail'],
					},
				},
			},

			// ----------------------------------
			//     lead: add note
			// ----------------------------------
			{
				displayName: 'Keep Status Unchanged',
				name: 'keepStatusUnchanged',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['addNote'],
					},
				},
				description:
					'Whether to keep the lead status unchanged. By default, adding a note also changes the status of the lead.',
			},
			{
				displayName: 'Attachments',
				name: 'attachments',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add Attachment',
				default: {},
				displayOptions: {
					show: {
						resource: ['lead'],
						operation: ['addNote'],
					},
				},
				options: [
					{
						name: 'attachment',
						displayName: 'Attachment',
						values: [
							{
								displayName: 'File Name',
								name: 'fileName',
								type: 'string',
								default: '',
								description:
									'File name without path, for example photo.jpg. If empty, the file name of the binary data is used.',
							},
							{
								displayName: 'Image Optimization',
								name: 'imageOptimization',
								type: 'boolean',
								default: true,
								description: 'Whether autocrm may optimize (recompress) image attachments',
							},
							{
								displayName: 'Input Binary Field',
								name: 'binaryPropertyName',
								type: 'string',
								default: 'data',
								hint: 'The name of the input binary field containing the file to attach',
							},
						],
					},
				],
			},
		],
	};

	methods = {
		credentialTest: {
			async autoCrmApiTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const data = (credential.data ?? {}) as IDataObject;
				const credentials: AutoCrmCredentials = {
					baseUrl: String(data.baseUrl ?? ''),
					username: String(data.username ?? ''),
					password: String(data.password ?? ''),
				};
				try {
					// cheap read-only call (150/60s); any JSON answer with a status field proves valid auth
					await autoCrmRequest(credentials, 'AnfrageVorhanden', { 'id-anfrage': 1 });
					return { status: 'OK', message: 'Authentication successful' };
				} catch (error) {
					if (error instanceof AutoCrmApiError) {
						if (error.httpStatus === 401) {
							return { status: 'Error', message: 'Invalid username or password' };
						}
						if (error.statusError !== undefined) {
							return {
								status: 'OK',
								message: `Credentials are valid (server responded with "${error.statusError}")`,
							};
						}
						return { status: 'Error', message: error.message };
					}
					return { status: 'Error', message: (error as Error).message };
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				if (resource === 'lead' && operation === 'exists') {
					const leadId = getLeadId(this, i);
					const responseData = await autoCrmApiCall.call(
						this,
						'AnfrageVorhanden',
						{ 'id-anfrage': leadId },
						i,
					);
					returnData.push({ json: responseData, pairedItem: { item: i } });
					continue;
				}

				if (resource === 'lead' && operation === 'assign') {
					const leadId = getLeadId(this, i);
					const assignTo = this.getNodeParameter('assignTo', i) as string;
					const body: IDataObject = { 'id-anfrage': leadId };
					const branchId = String(this.getNodeParameter('branchId', i, '') ?? '').trim();
					const category = String(this.getNodeParameter('category', i, '') ?? '').trim();
					if (branchId !== '') body['id-niederlassung'] = branchId;
					if (category !== '') body.kategorie = category;
					if (assignTo === 'employee') {
						body.email = getRequiredString(this, 'employeeEmail', 'Employee Email', i);
					}
					await autoCrmApiCall.call(this, 'AnfrageZuweisen', body, i);
					returnData.push({
						json: { success: true, 'id-anfrage': leadId },
						pairedItem: { item: i },
					});
					continue;
				}

				if (resource === 'lead' && operation === 'attachEmail') {
					const leadId = getLeadId(this, i);
					const emlSource = this.getNodeParameter('emlSource', i) as string;
					let eml64: string;
					if (emlSource === 'binary') {
						const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;
						this.helpers.assertBinaryData(i, binaryPropertyName);
						const buffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
						eml64 = buffer.toString('base64');
					} else {
						const emlText = String(this.getNodeParameter('emlText', i) ?? '');
						if (emlText.trim() === '') {
							throw new NodeOperationError(this.getNode(), '"EML Text" must not be empty', {
								itemIndex: i,
							});
						}
						eml64 = Buffer.from(emlText, 'utf8').toString('base64');
					}
					assertBase64Size(this.getNode(), i, eml64.length, 'The email');
					await autoCrmApiCall.call(
						this,
						'AnfrageEmail',
						{ 'id-anfrage': leadId, 'text-eml64': eml64 },
						i,
					);
					returnData.push({
						json: { success: true, 'id-anfrage': leadId },
						pairedItem: { item: i },
					});
					continue;
				}

				if (resource === 'lead' && operation === 'addNote') {
					const leadId = getLeadId(this, i);
					const noteTitle = getRequiredString(this, 'noteTitle', 'Note Title', i);
					const noteContent = getRequiredString(this, 'noteContent', 'Note Content', i);
					const keepStatusUnchanged = this.getNodeParameter('keepStatusUnchanged', i) as boolean;
					const attachmentsParam = this.getNodeParameter('attachments', i, {}) as IDataObject;
					const entries = (attachmentsParam.attachment as IDataObject[] | undefined) ?? [];

					const anhaenge: IDataObject[] = [];
					let totalBase64 = 0;
					for (const entry of entries) {
						const binaryPropertyName = String(entry.binaryPropertyName ?? 'data');
						const binaryData = this.helpers.assertBinaryData(i, binaryPropertyName);
						const buffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
						const data64 = buffer.toString('base64');
						assertBase64Size(this.getNode(), i, data64.length, `Attachment "${binaryPropertyName}"`);
						totalBase64 += data64.length;
						assertBase64Size(this.getNode(), i, totalBase64, 'The sum of all attachments');

						let fileName = String(entry.fileName ?? '').trim();
						if (fileName === '') fileName = binaryData.fileName ?? '';
						fileName = fileName.split(/[\\/]/).pop() ?? '';
						if (fileName === '') fileName = 'attachment';

						const anhang: IDataObject = { dateiname: fileName, data64 };
						if (entry.imageOptimization === false) anhang.optimierung = false;
						anhaenge.push(anhang);
					}

					const notiz: IDataObject = { titel: noteTitle, inhalt: noteContent };
					if (anhaenge.length > 0) notiz.anhaenge = anhaenge;
					const body: IDataObject = { 'id-anfrage': leadId, notiz };
					if (keepStatusUnchanged) body['status-unveraendert'] = true;

					await autoCrmApiCall.call(this, 'AnfrageNotiz', body, i);
					returnData.push({
						json: { success: true, 'id-anfrage': leadId },
						pairedItem: { item: i },
					});
					continue;
				}

				if (resource === 'lead' && operation === 'create') {
					const node = this.getNode();

					// --- contact ---
					const contactId = getRequiredString(this, 'contactId', 'Contact ID', i);
					const lastName = getRequiredString(this, 'lastName', 'Last Name', i);
					const email = String(this.getNodeParameter('email', i, '') ?? '').trim();
					const additionalContact = this.getNodeParameter(
						'additionalContactFields',
						i,
						{},
					) as IDataObject;

					const kontakt: IDataObject = { 'x-id-kontakt': contactId, name: lastName };
					if (email !== '') kontakt.email = email;
					for (const [uiName, apiName] of Object.entries(CONTACT_FIELD_MAP)) {
						const rawValue = additionalContact[uiName];
						if (rawValue === undefined || rawValue === null) continue;
						const stringValue = String(rawValue).trim();
						if (stringValue === '') continue;
						kontakt[apiName] =
							uiName in PHONE_FIELD_LABELS
								? normalizePhoneNumber(node, i, PHONE_FIELD_LABELS[uiName], stringValue)
								: stringValue;
					}
					if (
						kontakt.email === undefined &&
						kontakt.telefon === undefined &&
						kontakt.mobil === undefined
					) {
						throw new NodeOperationError(
							node,
							'autocrm requires at least one of Email, Phone or Mobile for the contact',
							{
								itemIndex: i,
								description:
									'Fill the Email field or add Phone / Mobile under Additional Contact Fields.',
							},
						);
					}

					// --- lead ---
					const branchId = getRequiredString(this, 'branchId', 'Branch ID', i);
					const category = getRequiredString(this, 'category', 'Category', i);
					const firstContactChannel = this.getNodeParameter('firstContactChannel', i) as string;
					const source = getRequiredString(this, 'source', 'Source', i);
					const additionalLead = this.getNodeParameter(
						'additionalLeadFields',
						i,
						{},
					) as IDataObject;

					const anfrage: IDataObject = {
						niederlassung: branchId,
						kategorie: category,
						erstkontakt: firstContactChannel,
						quelle: source,
					};
					const externalLeadId = String(additionalLead.externalLeadId ?? '').trim();
					const externalLeadIdType = String(additionalLead.externalLeadIdType ?? '').trim();
					if (externalLeadIdType !== '' && externalLeadId === '') {
						throw new NodeOperationError(
							node,
							'"External Lead ID Type" is only allowed together with "External Lead ID"',
							{ itemIndex: i },
						);
					}
					if (externalLeadId !== '') anfrage['x-id-anfrage'] = externalLeadId;
					if (externalLeadIdType !== '') anfrage['x-id-anfrage-typ'] = externalLeadIdType;
					const assigneeEmail = String(additionalLead.assigneeEmail ?? '').trim();
					if (assigneeEmail !== '') anfrage.bearbeiter = assigneeEmail;
					const leadTitle = String(additionalLead.leadTitle ?? '').trim();
					if (leadTitle !== '') anfrage.titel = leadTitle;
					const status = String(additionalLead.status ?? '').trim();
					if (status !== '') anfrage.status = status;
					const remarks = String(additionalLead.remarks ?? '').trim();
					if (remarks !== '') anfrage.bemerkungen = remarks;
					if (typeof additionalLead.offerPrice === 'number') {
						anfrage.angebotspreis = additionalLead.offerPrice;
					}
					const timestampFields: Array<[string, string, string]> = [
						['processFrom', 'bearbeiten-ab', 'Process From'],
						['processBy', 'bearbeiten-bis', 'Process By'],
						['closeBy', 'abschliessen-bis', 'Close By'],
					];
					for (const [uiName, apiName, label] of timestampFields) {
						const rawValue = String(additionalLead[uiName] ?? '').trim();
						if (rawValue === '') continue;
						anfrage[apiName] = toApiTimestamp(node, i, label, rawValue);
					}

					// --- history note ---
					const noteTitle = getRequiredString(this, 'noteTitle', 'Note Title', i);
					const noteContent = getRequiredString(this, 'noteContent', 'Note Content', i);

					const body: IDataObject = {
						kontakt: pruneEmpty(kontakt),
						anfrage: pruneEmpty(anfrage),
						verlauf: [{ typ: 'notiz', data: { titel: noteTitle, inhalt: noteContent } }],
					};

					// --- vehicle ---
					const vehicle = this.getNodeParameter('vehicle', i, {}) as IDataObject;
					const vehicleId = String(vehicle.vehicleId ?? '').trim();
					const vehicleText = String(vehicle.description ?? '').trim();
					if (vehicleId !== '' || vehicleText !== '') {
						if (vehicleId === '' || vehicleText === '') {
							throw new NodeOperationError(
								node,
								'The Vehicle collection needs both Vehicle ID and Description',
								{ itemIndex: i },
							);
						}
						body.fahrzeug = { 'x-id-fahrzeug': vehicleId, text: vehicleText };
					}

					const responseData = await autoCrmApiCall.call(this, 'NeueAnfrage', body, i);
					returnData.push({ json: responseData, pairedItem: { item: i } });
					continue;
				}

				throw new NodeOperationError(
					this.getNode(),
					`Unknown operation "${operation}" for resource "${resource}"`,
					{ itemIndex: i },
				);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: error.message }, pairedItem: { item: i } });
					continue;
				}
				if (error.context) {
					error.context.itemIndex = i;
					throw error;
				}
				throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
