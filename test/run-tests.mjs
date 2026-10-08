// Mock-Harness für @benheidenreich/n8n-nodes-autocrm — läuft komplett offline,
// kein Kontakt zur echten autocrm-API. Getestet werden die Transport-Schicht
// (308-Redirect + Auth-Erhalt, Redirect-Cache samt Fallback, Retries mit
// Retry-After, Mutex-Serialisierung, Fehler-Mapping) und die execute()-Zweige
// aller 6 Operationen gegen lokale HTTP-Server.
//
// Aufruf: npm test   (baut dist/ und führt diese Datei aus)
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'nodes', 'AutoCrm');
const { autoCrmRequest, AutoCrmApiError, clearAutoCrmRuntimeCaches } = require(
	join(DIST, 'transport.js'),
);
const { AutoCrm } = require(join(DIST, 'AutoCrm.node.js'));

// ---------- infrastructure ----------

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

async function startServer(handler) {
	const state = { count: 0, requests: [] };
	const server = createServer(async (req, res) => {
		state.count++;
		const body = await readBody(req);
		state.requests.push({
			method: req.method,
			url: req.url,
			headers: req.headers,
			body,
		});
		await handler(req, res, body, state);
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const { port } = server.address();
	return { server, port, url: `http://127.0.0.1:${port}`, state };
}

function okJson(res, data = {}) {
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ status: 'OK', data }));
}

const CREDS = (url) => ({ baseUrl: url, username: 'apiuser', password: 'apipass' });
const EXPECTED_AUTH = 'Basic ' + Buffer.from('apiuser:apipass').toString('base64');

const results = [];

async function testCase(name, fn) {
	clearAutoCrmRuntimeCaches();
	try {
		await fn();
		results.push(['PASS', name]);
		console.log(`PASS  ${name}`);
	} catch (error) {
		results.push(['FAIL', name, error]);
		console.log(`FAIL  ${name}\n      ${error.message}`);
	}
}

async function withServers(defs, fn) {
	const started = [];
	for (const def of defs) started.push(await startServer(def));
	try {
		return await fn(...started);
	} finally {
		for (const s of started) s.server.close();
	}
}

// mock IExecuteFunctions context
function makeExecContext({ params, items, binary, creds, continueOnFail }) {
	return {
		getInputData: () => items ?? [{ json: {} }],
		getNodeParameter(name, _i, fallback) {
			if (name in params) return params[name];
			if (arguments.length >= 3) return fallback;
			throw new Error(`Mock: missing parameter "${name}"`);
		},
		getNode: () => ({
			id: 'test-node',
			name: 'autocrm test',
			type: 'n8n-nodes-autocrm.autoCrm',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		continueOnFail: () => continueOnFail === true,
		getCredentials: async () => creds,
		helpers: {
			assertBinaryData: (_i, prop) => {
				const entry = binary?.[prop];
				if (!entry) throw new Error(`Mock: no binary data property "${prop}"`);
				return entry.meta;
			},
			getBinaryDataBuffer: async (_i, prop) => binary[prop].buffer,
		},
	};
}

async function runOperation({ operation, params, binary, serverHandler, serverData, continueOnFail }) {
	return withServers([serverHandler ?? ((req, res) => okJson(res, serverData ?? {}))], async (srv) => {
		const ctx = makeExecContext({
			params: { resource: 'lead', operation, ...params },
			binary,
			creds: CREDS(srv.url),
			continueOnFail,
		});
		const node = new AutoCrm();
		const output = await node.execute.call(ctx);
		return { output, state: srv.state };
	});
}

// ---------- transport cases ----------

await testCase('a+b) 308 chain keeps method, body, Authorization; target is cached', async () => {
	const b = await startServer((req, res, body) => {
		assert.equal(req.method, 'POST');
		assert.equal(req.headers.authorization, EXPECTED_AUTH);
		assert.equal(req.headers['content-type'], 'application/json');
		const parsed = JSON.parse(body);
		assert.equal(parsed.version, '3.5');
		assert.equal(parsed.function, 'AnfrageVorhanden');
		assert.deepEqual(parsed.data, { 'id-anfrage': 7 });
		okJson(res, { existiert: 1, 'weitergefuehrt-in': null });
	});
	const a = await startServer((req, res) => {
		res.writeHead(308, { Location: `${b.url}/api` });
		res.end();
	});
	try {
		const data = await autoCrmRequest(CREDS(a.url), 'AnfrageVorhanden', { 'id-anfrage': 7 });
		assert.deepEqual(data, { existiert: 1, 'weitergefuehrt-in': null });
		assert.equal(a.state.count, 1);
		assert.equal(b.state.count, 1);

		// second call must hit the cached redirect target directly
		const data2 = await autoCrmRequest(CREDS(a.url), 'AnfrageVorhanden', { 'id-anfrage': 7 });
		assert.deepEqual(data2, { existiert: 1, 'weitergefuehrt-in': null });
		assert.equal(a.state.count, 1, 'origin must not be hit again (redirect target cached)');
		assert.equal(b.state.count, 2);
	} finally {
		a.server.close();
		b.server.close();
	}
});

await testCase('c) relative Location header is resolved', async () => {
	await withServers(
		[
			async (req, res) => {
				if (req.url === '/moved') {
					okJson(res, { landed: true });
				} else {
					res.writeHead(308, { Location: '/moved' });
					res.end();
				}
			},
		],
		async (srv) => {
			const data = await autoCrmRequest(CREDS(srv.url), 'AnfrageVorhanden', { 'id-anfrage': 1 });
			assert.deepEqual(data, { landed: true });
			assert.equal(srv.state.count, 2);
		},
	);
});

await testCase('d) redirect loop aborts after max redirects', async () => {
	await withServers(
		[
			(req, res) => {
				res.writeHead(308, { Location: '/loop' });
				res.end();
			},
		],
		async (srv) => {
			await assert.rejects(
				autoCrmRequest(CREDS(srv.url), 'AnfrageVorhanden', { 'id-anfrage': 1 }),
				(error) => error instanceof AutoCrmApiError && /redirected more than 5 times/.test(error.message),
			);
			assert.equal(srv.state.count, 6, '1 initial + 5 redirects');
		},
	);
});

await testCase('e) 401 with HTML body -> auth error, no retry, no parse crash', async () => {
	await withServers(
		[
			(req, res) => {
				res.writeHead(401, { 'Content-Type': 'text/html' });
				res.end('<html><body>401 Unauthorized</body></html>');
			},
		],
		async (srv) => {
			await assert.rejects(
				autoCrmRequest(CREDS(srv.url), 'AnfrageVorhanden', { 'id-anfrage': 1 }),
				(error) =>
					error instanceof AutoCrmApiError &&
					error.httpStatus === 401 &&
					/authentication failed/.test(error.message),
			);
			assert.equal(srv.state.count, 1, '401 must not be retried');
		},
	);
});

await testCase('f) 429 fehler_parallel with Retry-After succeeds on 2nd attempt', async () => {
	await withServers(
		[
			(req, res, body, state) => {
				if (state.count === 1) {
					res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
					res.end(JSON.stringify({ status: 'fehler_parallel' }));
				} else {
					okJson(res, { fine: true });
				}
			},
		],
		async (srv) => {
			const startedAt = Date.now();
			const data = await autoCrmRequest(CREDS(srv.url), 'AnfrageZuweisen', { 'id-anfrage': 1 });
			assert.deepEqual(data, { fine: true });
			assert.equal(srv.state.count, 2);
			assert.ok(Date.now() - startedAt >= 950, 'must wait for Retry-After');
		},
	);
});

await testCase('g) 503 fehler_tmp with Retry-After succeeds on 2nd attempt', async () => {
	await withServers(
		[
			(req, res, body, state) => {
				if (state.count === 1) {
					res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
					res.end(JSON.stringify({ status: 'fehler_tmp' }));
				} else {
					okJson(res, {});
				}
			},
		],
		async (srv) => {
			const data = await autoCrmRequest(CREDS(srv.url), 'AnfrageEmail', { 'id-anfrage': 1 });
			assert.deepEqual(data, {});
			assert.equal(srv.state.count, 2);
		},
	);
});

await testCase('h) persistent 429 fails after exactly 3 attempts', async () => {
	await withServers(
		[
			(req, res) => {
				res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
				res.end(JSON.stringify({ status: 'fehler_mengengeruest' }));
			},
		],
		async (srv) => {
			await assert.rejects(
				autoCrmRequest(CREDS(srv.url), 'NeueAnfrage', {}),
				(error) =>
					error instanceof AutoCrmApiError &&
					error.statusError === 'fehler_mengengeruest' &&
					/rate limit/.test(error.message),
			);
			assert.equal(srv.state.count, 3, '1 initial attempt + 2 retries');
		},
	);
});

await testCase('i) fehler_input fails immediately with field in message', async () => {
	await withServers(
		[
			(req, res) => {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ status: 'fehler_input:id_unbekannt:data.id-anfrage' }));
			},
		],
		async (srv) => {
			await assert.rejects(
				autoCrmRequest(CREDS(srv.url), 'AnfrageDetails', { 'id-anfrage': 99 }),
				(error) =>
					error instanceof AutoCrmApiError &&
					error.statusError === 'fehler_input:id_unbekannt:data.id-anfrage' &&
					/id_unbekannt/.test(error.message) &&
					/Exists/.test(error.description ?? ''),
			);
			assert.equal(srv.state.count, 1);
		},
	);
});

await testCase('j) HTTP 200 without status OK is an error', async () => {
	await withServers(
		[
			(req, res) => {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ status: 'fehler_intern' }));
			},
		],
		async (srv) => {
			await assert.rejects(
				autoCrmRequest(CREDS(srv.url), 'AnfrageVorhanden', { 'id-anfrage': 1 }),
				(error) => error instanceof AutoCrmApiError && error.statusError === 'fehler_intern',
			);
			assert.equal(srv.state.count, 1);
		},
	);
});

await testCase('k) mutex: 3 parallel calls never overlap on the server', async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	await withServers(
		[
			async (req, res) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 100));
				inFlight--;
				okJson(res, {});
			},
		],
		async (srv) => {
			await Promise.all([
				autoCrmRequest(CREDS(srv.url), 'AnfrageVorhanden', { 'id-anfrage': 1 }),
				autoCrmRequest(CREDS(srv.url), 'AnfrageVorhanden', { 'id-anfrage': 2 }),
				autoCrmRequest(CREDS(srv.url), 'AnfrageVorhanden', { 'id-anfrage': 3 }),
			]);
			assert.equal(srv.state.count, 3);
			assert.equal(maxInFlight, 1, 'requests of the same API user must be serialized');
		},
	);
});

await testCase('l) dead cached redirect target -> fallback to base URL, new target', async () => {
	const c = await startServer((req, res) => okJson(res, { from: 'c' }));
	const b = await startServer((req, res) => okJson(res, { from: 'b' }));
	let target = b.url;
	const a = await startServer((req, res) => {
		res.writeHead(308, { Location: target });
		res.end();
	});
	try {
		const first = await autoCrmRequest(CREDS(a.url), 'AnfrageVorhanden', { 'id-anfrage': 1 });
		assert.deepEqual(first, { from: 'b' });
		// simulate server move: b goes away, a now redirects to c
		b.server.close();
		await new Promise((resolve) => setTimeout(resolve, 50));
		target = c.url;
		const second = await autoCrmRequest(CREDS(a.url), 'AnfrageVorhanden', { 'id-anfrage': 1 });
		assert.deepEqual(second, { from: 'c' });
		assert.equal(a.state.count, 2, 'base URL used again after cached target died');
	} finally {
		a.server.close();
		c.server.close();
	}
});

await testCase('m) credential test: OK server / 401 server / permission error', async () => {
	const node = new AutoCrm();
	const testFn = node.methods.credentialTest.autoCrmApiTest;
	const makeCredential = (url) => ({
		id: '1',
		name: 'autocrm account',
		type: 'autoCrmApi',
		data: { baseUrl: url, username: 'apiuser', password: 'apipass' },
	});

	await withServers([(req, res) => okJson(res, { existiert: 0 })], async (srv) => {
		const result = await testFn.call({}, makeCredential(srv.url));
		assert.deepEqual(result, { status: 'OK', message: 'Authentication successful' });
		const parsed = JSON.parse(srv.state.requests[0].body);
		assert.equal(parsed.function, 'AnfrageVorhanden');
		assert.deepEqual(parsed.data, { 'id-anfrage': 1 });
	});

	clearAutoCrmRuntimeCaches();
	await withServers(
		[
			(req, res) => {
				res.writeHead(401, { 'Content-Type': 'text/html' });
				res.end('<html>nope</html>');
			},
		],
		async (srv) => {
			const result = await testFn.call({}, makeCredential(srv.url));
			assert.deepEqual(result, { status: 'Error', message: 'Invalid username or password' });
		},
	);

	clearAutoCrmRuntimeCaches();
	await withServers(
		[
			(req, res) => {
				res.writeHead(403, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ status: 'fehler_berechtigung' }));
			},
		],
		async (srv) => {
			const result = await testFn.call({}, makeCredential(srv.url));
			assert.equal(result.status, 'OK', 'a JSON status answer proves valid auth');
			assert.match(result.message, /fehler_berechtigung/);
		},
	);
});

// ---------- operation body-smoke cases (real execute() with mocked n8n context) ----------

await testCase('n1) create: full body mapping incl. phone + timestamp + vehicle', async () => {
	const { output, state } = await runOperation({
		operation: 'create',
		serverData: { 'id-anfrage': 123, 'id-kontakt': 456, 'neuer-kontakt': true },
		params: {
			contactId: 'CRM-0001',
			lastName: 'Mustermann',
			email: 'max@example.com',
			branchId: 'BRANCH_ID',
			category: 'PARENT|CHILD',
			firstContactChannel: 'E-Mail',
			source: 'Homepage',
			noteTitle: 'Customer message',
			noteContent: 'Please send an offer.',
			additionalContactFields: {
				salutation: 'Herr',
				firstName: 'Max',
				phone: '+49 6301 708-123456',
				licensePlate: 'KL AB 123',
				country: 'DE',
			},
			additionalLeadFields: {
				assigneeEmail: 'agent@autocrm-tenant.example',
				status: 'in Bearbeitung',
				offerPrice: 24990,
				processFrom: '2026-01-15T09:30:00.000Z',
				externalLeadId: 'LEAD-77',
				externalLeadIdType: 'GCLID',
			},
			vehicle: { vehicleId: 'V-1', description: 'Example car, first registration 2020' },
		},
	});
	const parsed = JSON.parse(state.requests[0].body);
	assert.equal(parsed.version, '3.5');
	assert.equal(parsed.function, 'NeueAnfrage');
	assert.deepEqual(parsed.data.kontakt, {
		'x-id-kontakt': 'CRM-0001',
		name: 'Mustermann',
		email: 'max@example.com',
		anrede: 'Herr',
		vorname: 'Max',
		telefon: '+496301708123456',
		'kfz-kennzeichen': 'KL AB 123',
		land: 'DE',
	});
	assert.deepEqual(parsed.data.anfrage, {
		niederlassung: 'BRANCH_ID',
		kategorie: 'PARENT|CHILD',
		erstkontakt: 'E-Mail',
		quelle: 'Homepage',
		'x-id-anfrage': 'LEAD-77',
		'x-id-anfrage-typ': 'GCLID',
		bearbeiter: 'agent@autocrm-tenant.example',
		status: 'in Bearbeitung',
		angebotspreis: 24990,
		'bearbeiten-ab': '2026-01-15 10:30:00',
	});
	assert.deepEqual(parsed.data.verlauf, [
		{ typ: 'notiz', data: { titel: 'Customer message', inhalt: 'Please send an offer.' } },
	]);
	assert.deepEqual(parsed.data.fahrzeug, {
		'x-id-fahrzeug': 'V-1',
		text: 'Example car, first registration 2020',
	});
	assert.deepEqual(output[0][0].json, {
		'id-anfrage': 123,
		'id-kontakt': 456,
		'neuer-kontakt': true,
	});
	assert.deepEqual(output[0][0].pairedItem, { item: 0 });
});

await testCase('n2) create: missing email/phone/mobile is rejected before the request', async () => {
	await assert.rejects(
		runOperation({
			operation: 'create',
			params: {
				contactId: 'CRM-0002',
				lastName: 'Mustermann',
				email: '',
				branchId: 'BRANCH_ID',
				category: 'CATEGORY',
				firstContactChannel: 'Telefon',
				source: 'SOURCE_NAME',
				noteTitle: 'T',
				noteContent: 'C',
				additionalContactFields: {},
				additionalLeadFields: {},
				vehicle: {},
			},
		}),
		/at least one of Email, Phone or Mobile/,
	);
});

await testCase('n3) create: vehicle with only one field is rejected', async () => {
	await assert.rejects(
		runOperation({
			operation: 'create',
			params: {
				contactId: 'CRM-0003',
				lastName: 'Mustermann',
				email: 'a@example.com',
				branchId: 'BRANCH_ID',
				category: 'CATEGORY',
				firstContactChannel: 'E-Mail',
				source: 'SOURCE_NAME',
				noteTitle: 'T',
				noteContent: 'C',
				additionalContactFields: {},
				additionalLeadFields: {},
				vehicle: { vehicleId: 'V-1' },
			},
		}),
		/Vehicle ID and Description/,
	);
});

await testCase('n4) assign to employee builds the right body', async () => {
	const { output, state } = await runOperation({
		operation: 'assign',
		params: {
			leadId: 12345,
			assignTo: 'employee',
			employeeEmail: 'sales.person@dealership.example',
			branchId: '',
			category: 'Service',
		},
	});
	const parsed = JSON.parse(state.requests[0].body);
	assert.equal(parsed.function, 'AnfrageZuweisen');
	assert.deepEqual(parsed.data, {
		'id-anfrage': 12345,
		kategorie: 'Service',
		email: 'sales.person@dealership.example',
	});
	assert.deepEqual(output[0][0].json, { success: true, 'id-anfrage': 12345 });
});

await testCase('n5) assign to team omits the email key entirely', async () => {
	const { state } = await runOperation({
		operation: 'assign',
		params: { leadId: 12345, assignTo: 'team', branchId: 'BRANCH_ID', category: '' },
	});
	const parsed = JSON.parse(state.requests[0].body);
	assert.deepEqual(parsed.data, { 'id-anfrage': 12345, 'id-niederlassung': 'BRANCH_ID' });
	assert.ok(!('email' in parsed.data), 'email key must be absent for team assignment');
});

await testCase('n6) attach email from raw text is base64-encoded', async () => {
	const eml = 'MIME-Version: 1.0\r\nFrom: a@example.com\r\nTo: b@example.com\r\nSubject: Hi\r\n\r\nHello';
	const { state } = await runOperation({
		operation: 'attachEmail',
		params: { leadId: 42, emlSource: 'raw', emlText: eml },
	});
	const parsed = JSON.parse(state.requests[0].body);
	assert.equal(parsed.function, 'AnfrageEmail');
	assert.equal(parsed.data['id-anfrage'], 42);
	assert.equal(Buffer.from(parsed.data['text-eml64'], 'base64').toString('utf8'), eml);
});

await testCase('n7) attach email from binary field', async () => {
	const emlBuffer = Buffer.from('From: x@example.com\r\n\r\nBody');
	const { state } = await runOperation({
		operation: 'attachEmail',
		params: { leadId: 43, emlSource: 'binary', binaryPropertyName: 'data' },
		binary: { data: { meta: { fileName: 'mail.eml', mimeType: 'message/rfc822' }, buffer: emlBuffer } },
	});
	const parsed = JSON.parse(state.requests[0].body);
	assert.equal(parsed.data['text-eml64'], emlBuffer.toString('base64'));
});

await testCase('n8) add note with attachment and unchanged status', async () => {
	const fileBuffer = Buffer.from('fake-image-bytes');
	const { state } = await runOperation({
		operation: 'addNote',
		params: {
			leadId: 99,
			noteTitle: 'Damage report',
			noteContent: 'See attachment',
			keepStatusUnchanged: true,
			attachments: {
				attachment: [
					{ binaryPropertyName: 'photo', fileName: '', imageOptimization: false },
				],
			},
		},
		binary: {
			photo: { meta: { fileName: 'C:\\temp\\damage1.jpg', mimeType: 'image/jpeg' }, buffer: fileBuffer },
		},
	});
	const parsed = JSON.parse(state.requests[0].body);
	assert.equal(parsed.function, 'AnfrageNotiz');
	assert.deepEqual(parsed.data, {
		'id-anfrage': 99,
		'status-unveraendert': true,
		notiz: {
			titel: 'Damage report',
			inhalt: 'See attachment',
			anhaenge: [
				{ dateiname: 'damage1.jpg', data64: fileBuffer.toString('base64'), optimierung: false },
			],
		},
	});
});

await testCase('n9) exists passes the response through unchanged', async () => {
	const { output, state } = await runOperation({
		operation: 'exists',
		params: { leadId: 11111 },
		serverData: { existiert: 0, 'weitergefuehrt-in': 12345 },
	});
	const parsed = JSON.parse(state.requests[0].body);
	assert.equal(parsed.function, 'AnfrageVorhanden');
	assert.deepEqual(parsed.data, { 'id-anfrage': 11111 });
	assert.deepEqual(output[0][0].json, { existiert: 0, 'weitergefuehrt-in': 12345 });
});

await testCase('n10) invalid lead ID is rejected before any request', async () => {
	await assert.rejects(
		runOperation({ operation: 'exists', params: { leadId: 0 } }),
		/positive whole number/,
	);
});

await testCase('n11) continueOnFail turns errors into items with pairedItem', async () => {
	const { output } = await runOperation({
		operation: 'exists',
		params: { leadId: -5 },
		continueOnFail: true,
	});
	assert.match(String(output[0][0].json.error), /positive whole number/);
	assert.deepEqual(output[0][0].pairedItem, { item: 0 });
});

await testCase('n12) search maps all filters incl. branch and splits IDs into items', async () => {
	const { output, state } = await runOperation({
		operation: 'search',
		params: {
			filters: {
				branchId: 'BRANCH_ID',
				createdFrom: '2026-03-20T11:00:00.000Z',
				createdUntil: '2026-07-01T15:00:00.000Z',
				changedFrom: '2026-03-21T11:00:00.000Z',
				changedUntil: '',
				vehicleId: 'V-1',
				milestone: 'Angebot',
			},
		},
		serverData: { 'liste-id-anfrage': [1234567, 3456789] },
	});
	const parsed = JSON.parse(state.requests[0].body);
	assert.equal(parsed.function, 'AnfragenListeIDs');
	assert.deepEqual(parsed.data, {
		'id-niederlassung': 'BRANCH_ID',
		'meilenstein-gesetzt': 'Angebot',
		'x-id-fahrzeug': 'V-1',
		'erzeugt-von': '2026-03-20 12:00:00',
		'erzeugt-bis': '2026-07-01 17:00:00',
		'geaendert-von': '2026-03-21 12:00:00',
	});
	assert.deepEqual(
		output[0].map((item) => item.json),
		[{ 'id-anfrage': 1234567 }, { 'id-anfrage': 3456789 }],
	);
	assert.deepEqual(
		output[0].map((item) => item.pairedItem),
		[{ item: 0 }, { item: 0 }],
	);
});

await testCase('n13) search without filters sends empty data; empty result yields no items', async () => {
	const { output, state } = await runOperation({
		operation: 'search',
		params: {},
		serverData: { 'liste-id-anfrage': [] },
	});
	const parsed = JSON.parse(state.requests[0].body);
	assert.deepEqual(parsed.data, {});
	assert.deepEqual(output, [[]]);
});

await testCase('n14) search rejects an invalid date before any request', async () => {
	await assert.rejects(
		runOperation({ operation: 'search', params: { filters: { createdFrom: 'yesterday-ish' } } }),
		/"Created From" is not a valid date/,
	);
});

// ---------- summary ----------

const failed = results.filter(([status]) => status === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} cases passed`);
if (failed.length > 0) {
	for (const [, name, error] of failed) {
		console.error(`\n--- ${name} ---`);
		console.error(error);
	}
	process.exit(1);
}
process.exit(0);
