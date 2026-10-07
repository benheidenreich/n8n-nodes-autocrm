import type { IDataObject } from 'n8n-workflow';
import { sleep } from 'n8n-workflow';

// Transport layer for the autocrm API3. Deliberately free of n8n runtime types and
// error classes so it can be exercised standalone (see the mock test harness);
// AutoCrm.node.ts translates AutoCrmApiError into NodeApiError.

const API_VERSION = '3.5';
const MAX_REDIRECTS = 5;
const MAX_RETRIES = 2;
const MIN_RETRY_WAIT_MS = 1_000;
const MAX_RETRY_WAIT_MS = 30_000;
const DEFAULT_RETRY_WAIT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 120_000;
// autocrm limit for base64 payloads (per attachment, sum of attachments and .eml files)
export const MAX_BASE64_CHARS = 50 * 1024 * 1024;

export interface AutoCrmCredentials {
	baseUrl: string;
	username: string;
	password: string;
}

export class AutoCrmApiError extends Error {
	httpStatus?: number;

	statusError?: string;

	description?: string;

	constructor(
		message: string,
		options: { httpStatus?: number; statusError?: string; description?: string } = {},
	) {
		super(message);
		this.name = 'AutoCrmApiError';
		this.httpStatus = options.httpStatus;
		this.statusError = options.statusError;
		this.description = options.description;
	}
}

// Network-level rejections from fetch (DNS, TLS, timeouts) carry no API detail;
// this normalizes them into the same error type the rest of the module uses,
// which AutoCrm.node.ts then surfaces as a NodeApiError
function asTransportError(error: unknown, startUrl: string): AutoCrmApiError {
	if (error instanceof AutoCrmApiError) return error;
	return new AutoCrmApiError(
		`Could not reach the autocrm API at ${startUrl}: ${(error as Error).message}`,
	);
}

// The redirect target may be used directly for subsequent requests (spec section 1.7.4)
const redirectTargetCache = new Map<string, string>();
// autocrm allows only ONE request at a time per API user; this serializes requests
// within this Node.js process (see docs for the multi-process limitation)
const requestQueueTails = new Map<string, Promise<unknown>>();

export function clearAutoCrmRuntimeCaches(): void {
	redirectTargetCache.clear();
	requestQueueTails.clear();
}

async function runSerialized<T>(key: string, task: () => Promise<T>): Promise<T> {
	const tail = requestQueueTails.get(key) ?? Promise.resolve();
	// run regardless of whether the previous request succeeded or failed
	const run = tail.then(task, task);
	requestQueueTails.set(
		key,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	return run;
}

function parseRetryAfterMs(headerValue: string | null): number | undefined {
	if (headerValue === null || headerValue.trim() === '') return undefined;
	const seconds = Number(headerValue);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const dateMs = Date.parse(headerValue);
	if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
	return undefined;
}

interface RawResponse {
	status: number;
	retryAfter: string | null;
	bodyText: string;
	finalUrl: string;
}

// The autocrm API answers with HTTP 308 redirects to another subdomain as the normal case.
// Method, body AND the Authorization header must survive the redirect, which standard HTTP
// clients (including axios/follow-redirects used by the n8n request helpers) do not
// guarantee for cross-host redirects. Therefore redirects are followed manually here.
async function fetchWithManualRedirects(
	startUrl: string,
	headers: Record<string, string>,
	bodyText: string,
): Promise<RawResponse> {
	let url = startUrl;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: bodyText,
			redirect: 'manual',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const location = response.headers.get('location');
		if (response.status >= 300 && response.status < 400 && location !== null) {
			await response.arrayBuffer().catch(() => undefined);
			url = new URL(location, url).toString();
			continue;
		}
		const responseText = await response.text();
		return {
			status: response.status,
			retryAfter: response.headers.get('retry-after'),
			bodyText: responseText,
			finalUrl: url,
		};
	}
	throw new AutoCrmApiError(
		`The autocrm API redirected more than ${MAX_REDIRECTS} times without answering`,
		{},
	);
}

function buildStatusError(
	httpStatus: number,
	statusError: string | undefined,
	bodyText: string,
): AutoCrmApiError {
	if (statusError === undefined) {
		return new AutoCrmApiError(`Unexpected response from autocrm (HTTP ${httpStatus})`, {
			httpStatus,
			description: `The response could not be interpreted as an autocrm API answer. Response excerpt: ${bodyText.slice(0, 300)}`,
		});
	}
	if (statusError.startsWith('fehler_input')) {
		const parts = statusError.split(':');
		const detail = parts[1];
		const field = parts[2];
		let hint = 'autocrm rejected one of the sent values.';
		if (detail === 'id_unbekannt' && field === 'data.id-anfrage') {
			hint =
				'The lead ID does not exist in autocrm (or the API user may not access it). Use the "Exists" operation to check the ID first.';
		} else if (detail === 'unbekannt' && field === 'data.email') {
			hint =
				'No unique employee with this external email address is a valid assignee for the given branch and category. Note that autocrm expects the external dealership address here, not the autocrm login address.';
		}
		return new AutoCrmApiError(`autocrm rejected the input: ${statusError}`, {
			httpStatus,
			statusError,
			description: hint,
		});
	}
	switch (statusError) {
		case 'fehler_parallel':
			return new AutoCrmApiError(
				'autocrm allows only one request at a time per API user (fehler_parallel)',
				{
					httpStatus,
					statusError,
					description:
						'Another request of the same API user was still running, for example from a second n8n worker or another integration. The node already retried automatically; try again later and avoid parallel runs with the same credentials.',
				},
			);
		case 'fehler_mengengeruest':
			return new AutoCrmApiError('autocrm rate limit exceeded (fehler_mengengeruest)', {
				httpStatus,
				statusError,
				description:
					'Throughput limits per function: Create 3/60s, Search 4/60s, Assign / Attach Email / Add Note 5/60s, Exists 150/60s. The node already retried automatically; slow the workflow down, for example with a Wait node between items.',
			});
		case 'fehler_tmp':
			return new AutoCrmApiError(
				'autocrm is temporarily unable to process this request (fehler_tmp)',
				{
					httpStatus,
					statusError,
					description:
						'This is expected occasionally, for example while a phone call is running inside the lead. The node already retried automatically; try again later.',
				},
			);
		case 'fehler_json':
			return new AutoCrmApiError('autocrm could not parse the request body (fehler_json)', {
				httpStatus,
				statusError,
				description:
					'This points to an encoding problem in the node itself. Please report it as a bug.',
			});
		case 'fehler_berechtigung':
			return new AutoCrmApiError(
				'The API user lacks permission for this function (fehler_berechtigung)',
				{
					httpStatus,
					statusError,
					description: 'Ask autocrm support to enable the function for your API user.',
				},
			);
		case 'fehler_funktion':
			return new AutoCrmApiError('autocrm does not know the requested function (fehler_funktion)', {
				httpStatus,
				statusError,
			});
		case 'fehler_methode':
			return new AutoCrmApiError('autocrm rejected the HTTP method (fehler_methode)', {
				httpStatus,
				statusError,
			});
		case 'fehler_wartungsarbeiten':
			return new AutoCrmApiError('autocrm is under maintenance (fehler_wartungsarbeiten)', {
				httpStatus,
				statusError,
				description: 'Try again once the maintenance window is over.',
			});
		case 'fehler_intern':
			return new AutoCrmApiError('autocrm reported an internal error (fehler_intern)', {
				httpStatus,
				statusError,
				description: 'Try again later; if the problem persists, contact autocrm support.',
			});
		default:
			return new AutoCrmApiError(
				`autocrm returned the error "${statusError}" (HTTP ${httpStatus})`,
				{
					httpStatus,
					statusError,
				},
			);
	}
}

// Sends one API call: serialized per API user, following redirects manually and retrying
// temporary errors (429/503) with respect for the Retry-After header.
export async function autoCrmRequest(
	credentials: AutoCrmCredentials,
	functionName: string,
	data: IDataObject,
): Promise<IDataObject> {
	const baseUrl = credentials.baseUrl.trim().replace(/\/+$/, '');
	if (baseUrl === '') {
		throw new AutoCrmApiError('The autocrm Base URL is empty', {});
	}
	const credKey = `${baseUrl}|${credentials.username}`;
	return runSerialized(credKey, async () => {
		const bodyText = JSON.stringify({ version: API_VERSION, function: functionName, data });
		const headers: Record<string, string> = {
			Authorization:
				'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64'),
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};

		const doFetch = async (startUrl: string): Promise<RawResponse> => {
			try {
				return await fetchWithManualRedirects(startUrl, headers, bodyText);
			} catch (error) {
				throw asTransportError(error, startUrl);
			}
		};

		for (let attempt = 0; ; attempt++) {
			let response: RawResponse;
			const cachedTarget = redirectTargetCache.get(credKey);
			if (cachedTarget === undefined) {
				response = await doFetch(baseUrl);
			} else {
				try {
					response = await doFetch(cachedTarget);
				} catch {
					// the cached redirect target may have moved or gone away — fall back once
					redirectTargetCache.delete(credKey);
					response = await doFetch(baseUrl);
				}
			}
			if (response.finalUrl !== baseUrl) {
				redirectTargetCache.set(credKey, response.finalUrl);
			}

			// autocrm answers 401 with an HTML page, so never parse blindly
			let parsed: IDataObject | undefined;
			try {
				parsed = JSON.parse(response.bodyText) as IDataObject;
			} catch {
				parsed = undefined;
			}
			const statusField = typeof parsed?.status === 'string' ? (parsed.status as string) : undefined;

			if (response.status === 401) {
				throw new AutoCrmApiError('autocrm authentication failed (HTTP 401)', {
					httpStatus: 401,
					description:
						'Check the username and password of your autocrm API credential. The autocrm server answers unauthorized requests with an HTML page instead of JSON.',
				});
			}

			// success requires BOTH an HTTP 2xx status AND status "OK" in the body (spec section 1.6)
			if (response.status >= 200 && response.status < 300 && statusField === 'OK') {
				const responseData = parsed?.data;
				if (
					responseData !== null &&
					typeof responseData === 'object' &&
					!Array.isArray(responseData)
				) {
					return responseData as IDataObject;
				}
				return {};
			}

			const retryable =
				response.status === 429 ||
				response.status === 503 ||
				statusField === 'fehler_parallel' ||
				statusField === 'fehler_mengengeruest' ||
				statusField === 'fehler_tmp';
			if (retryable && attempt < MAX_RETRIES) {
				const retryAfterMs = parseRetryAfterMs(response.retryAfter);
				const waitMs = Math.min(
					Math.max(retryAfterMs ?? DEFAULT_RETRY_WAIT_MS, MIN_RETRY_WAIT_MS),
					MAX_RETRY_WAIT_MS,
				);
				await sleep(waitMs);
				continue;
			}

			throw buildStatusError(response.status, statusField, response.bodyText);
		}
	});
}
