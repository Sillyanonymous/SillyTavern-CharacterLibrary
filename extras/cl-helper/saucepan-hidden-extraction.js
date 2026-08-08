import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const CUSTOM_PROVIDER_PROFILES = new Set([
    'custom_and_vetted',
    'vetted_only_owner_bypass',
    'internal_only_owner_bypass',
]);

const BACKGROUND_MARKER = '[ Background ]';
const EXAMPLE_MARKER = '[ Example Dialogue ]';
const USER_MARKER = '[ User Description ]';
const CAPTURE_RESPONSE = 'CL_CAPTURE_OK';

export function canUseSaucepanCustomProvider(profile) {
    return CUSTOM_PROVIDER_PROFILES.has(profile);
}

export function parseSaucepanCapturedMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const system = list.find(message => message?.role === 'system' && typeof message.content === 'string');
    if (!system) throw new Error('Captured prompt is missing its system message');

    const backgroundAt = system.content.indexOf(BACKGROUND_MARKER);
    const exampleAt = system.content.indexOf(EXAMPLE_MARKER);
    const userAt = system.content.indexOf(USER_MARKER);
    if (backgroundAt < 0 || exampleAt < 0 || userAt < 0 || !(backgroundAt < exampleAt && exampleAt < userAt)) {
        throw new Error('Captured prompt section markers are missing or reordered');
    }

    const core = system.content.slice(backgroundAt + BACKGROUND_MARKER.length, exampleAt).trim();
    const exampleDialogue = system.content.slice(exampleAt + EXAMPLE_MARKER.length, userAt).trim();
    if (!core) throw new Error('Captured Companion Core is empty');

    const greeting = list.find(message => message?.role === 'assistant' && typeof message.content === 'string')?.content.trim() || '';
    return { core, exampleDialogue, greeting };
}

export async function createSaucepanCaptureListener({
    maxBodyBytes = 4 * 1024 * 1024,
    timeoutMs = 30_000,
    shutdownTimeoutMs = 2_000,
} = {}) {
    const providerPath = `/capture/${randomBytes(32).toString('hex')}/v1/chat/completions`;
    const apiKey = `cl-${randomBytes(32).toString('hex')}`;
    const waiters = [];
    let capturedPayload;
    let captureError;
    let claimed = false;
    let closed = false;
    let captureTimeout;
    const sockets = new Set();

    const settleWaiters = () => {
        while (waiters.length) {
            const { resolve, reject } = waiters.shift();
            if (captureError) reject(captureError);
            else resolve(capturedPayload);
        }
    };

    const server = createServer((request, response) => {
        if (request.url !== providerPath) {
            response.writeHead(404).end();
            return;
        }
        if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' }).end();
            return;
        }
        if (request.headers.authorization !== `Bearer ${apiKey}`) {
            response.writeHead(401).end();
            return;
        }
        if (claimed) {
            response.writeHead(410).end();
            return;
        }
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
            response.writeHead(415).end();
            return;
        }

        claimed = true;
        request.setTimeout(timeoutMs, () => request.destroy(new Error('Saucepan capture request timed out')));
        request.on('error', () => {
            if (!response.writableEnded) response.destroy();
        });
        const chunks = [];
        let receivedBytes = 0;
        let oversized = false;
        request.on('data', chunk => {
            receivedBytes += chunk.length;
            if (receivedBytes > maxBodyBytes) {
                oversized = true;
                chunks.length = 0;
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            if (oversized) {
                response.writeHead(413).end();
                return;
            }

            let payload;
            try {
                payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                response.writeHead(400).end();
                return;
            }

            capturedPayload = payload;
            clearTimeout(captureTimeout);
            settleWaiters();
            if (payload?.stream) {
                const chunk = {
                    id: 'character-library-capture',
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { role: 'assistant', content: CAPTURE_RESPONSE }, finish_reason: null }],
                };
                response.writeHead(200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache',
                    connection: 'keep-alive',
                });
                response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
                return;
            }

            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({
                id: 'character-library-capture',
                object: 'chat.completion',
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content: CAPTURE_RESPONSE },
                    finish_reason: 'stop',
                }],
            }));
        });
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });

    await new Promise((resolve, reject) => {
        const onError = error => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
    });

    return {
        apiKey,
        port: server.address().port,
        providerPath,
        waitForCapture() {
            if (captureError) return Promise.reject(captureError);
            if (capturedPayload !== undefined) return Promise.resolve(capturedPayload);
            if (closed) return Promise.reject(new Error('Saucepan capture listener is closed'));
            if (!captureTimeout) {
                captureTimeout = setTimeout(() => {
                    captureError = new Error('Timed out waiting for Saucepan to send the protected prompt');
                    settleWaiters();
                }, timeoutMs);
                captureTimeout.unref?.();
            }
            return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
        async close() {
            if (closed) return;
            closed = true;
            clearTimeout(captureTimeout);
            if (capturedPayload === undefined && !captureError) {
                captureError = new Error('Saucepan capture listener closed before receiving a prompt');
                settleWaiters();
            }
            const closePromise = new Promise((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
            const closedGracefully = await Promise.race([
                closePromise.then(() => true),
                new Promise(resolve => {
                    const timer = setTimeout(() => resolve(false), shutdownTimeoutMs);
                    timer.unref?.();
                }),
            ]);
            if (!closedGracefully) {
                for (const socket of sockets) socket.destroy();
                server.closeAllConnections?.();
                await closePromise;
            }
        },
    };
}

export async function startCloudflaredQuickTunnel({
    port,
    command = process.env.CLOUDFLARED_PATH || 'cloudflared',
    spawnImpl = spawn,
    timeoutMs = 25_000,
    shutdownTimeoutMs = 2_000,
} = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error('A valid loopback port is required for the Saucepan capture tunnel');
    }

    let child;
    try {
        child = spawnImpl(command, [
            'tunnel',
            '--url', `http://127.0.0.1:${port}`,
            '--no-autoupdate',
        ], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new Error('Install cloudflared or set CLOUDFLARED_PATH before extracting a protected Saucepan card');
        }
        throw error;
    }

    let exited = false;
    let publishedUrl;
    let output = '';
    let resolveExit;
    const exitPromise = new Promise(resolve => { resolveExit = resolve; });
    const markExited = () => {
        if (exited) return;
        exited = true;
        resolveExit();
    };

    const urlPromise = new Promise((resolve, reject) => {
        let timeout;
        const finish = (callback, value) => {
            clearTimeout(timeout);
            child.stdout?.off('data', onData);
            child.stderr?.off('data', onData);
            callback(value);
        };
        const onData = chunk => {
            output = `${output}${chunk}`.slice(-8_192);
            const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
            if (!match || publishedUrl) return;
            publishedUrl = match[0];
            finish(resolve, publishedUrl);
        };
        timeout = setTimeout(() => {
            finish(reject, new Error('Timed out waiting for cloudflared to publish a Quick Tunnel URL'));
        }, timeoutMs);
        timeout.unref?.();
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on('error', error => {
            if (publishedUrl) return;
            const message = error?.code === 'ENOENT'
                ? 'Install cloudflared or set CLOUDFLARED_PATH before extracting a protected Saucepan card'
                : `Could not start cloudflared: ${error?.message || error}`;
            finish(reject, new Error(message));
        });
        child.on('exit', code => {
            markExited();
            if (!publishedUrl) finish(reject, new Error(`cloudflared exited before publishing a Quick Tunnel URL (code ${code ?? 'unknown'})`));
        });
        child.on('close', markExited);
    });

    const waitForExit = async () => {
        if (exited) return true;
        return Promise.race([
            exitPromise.then(() => true),
            new Promise(resolve => {
                const timer = setTimeout(() => resolve(false), shutdownTimeoutMs);
                timer.unref?.();
            }),
        ]);
    };
    const stopChild = async () => {
        if (exited) return;
        child.kill?.('SIGTERM');
        if (await waitForExit()) return;
        child.kill?.('SIGKILL');
        if (await waitForExit()) return;
        throw new Error('Could not stop cloudflared after forced termination');
    };

    let url;
    try {
        url = await urlPromise;
    } catch (error) {
        try { await stopChild(); } catch { /* preserve the startup error */ }
        throw error;
    }

    let closePromise;
    return {
        url,
        close() {
            closePromise ||= stopChild();
            return closePromise;
        },
    };
}

export async function extractSaucepanHiddenDefinition({
    token,
    companionId,
    fetchImpl = fetch,
    openCapture = createSaucepanCaptureListener,
    openTunnel = startCloudflaredQuickTunnel,
    remoteTimeoutMs = 20_000,
    cleanupTimeoutMs = 5_000,
} = {}) {
    if (!token) throw new Error('Saucepan authentication is required');
    if (!companionId) throw new Error('A Saucepan companion ID is required');

    const baseUrl = 'https://saucepan.ai';
    const request = async (method, path, body, requestTimeoutMs = remoteTimeoutMs) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        timeout.unref?.();
        try {
            const response = await fetchImpl(`${baseUrl}${path}`, {
                method,
                signal: controller.signal,
                headers: {
                    authorization: `Bearer ${token}`,
                    accept: '*/*',
                    origin: baseUrl,
                    referer: `${baseUrl}/`,
                    'user-agent': 'Mozilla/5.0 (SillyTavern Character Library)',
                    'x-saucepan-client-version': '1',
                    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            let data;
            try {
                data = await response.json();
            } catch (error) {
                if (controller.signal.aborted) throw error;
                data = null;
            }
            if (!response.ok) {
                const detail = data?.error?.message || data?.error || data?.message;
                throw new Error(detail || `Saucepan HTTP ${response.status}`);
            }
            return data;
        } catch (error) {
            if (controller.signal.aborted) {
                const timeoutError = new Error('Saucepan request timed out');
                timeoutError.outcomeUnknown = method !== 'GET';
                throw timeoutError;
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    };

    const companion = await request('GET', `/api/v2/companions/${encodeURIComponent(companionId)}`);
    if (!canUseSaucepanCustomProvider(companion?.providers_profile)) {
        throw new Error('This companion does not allow custom providers');
    }

    let capture;
    let tunnel;
    let providerId;
    let chatId;
    let generationId;
    let result;
    let failure;
    const cleanupFailures = [];
    try {
        capture = await openCapture();
        tunnel = await openTunnel({ port: capture.port });

        const provider = await request('POST', '/api/v1/openai_provider/config', {
            config_name: 'Character Library temporary capture',
            provider: 'custom',
            model_id: 'cl-capture',
            api_key: capture.apiKey,
            temperature: 1,
            is_visible: false,
            provider_prompt: null,
            provider_post_history_prompt: null,
            context_length: 32000,
            provider_url: `${tunnel.url}${capture.providerPath}`,
            use_chat_temperature_override: false,
        });
        providerId = provider?.config_id;
        if (!providerId) throw new Error('Saucepan did not return a temporary provider ID');

        const scenarioId = companion?.starting_scenarios?.[0]?.id
            || companion?.starting_scenarios_fragments?.[0]?.id
            || null;
        const chat = await request('POST', '/api/v1/core/create-chat', {
            companion_id: companionId,
            chat_name: 'Character Library temporary extraction',
            metadata: { is_director: false },
            scenario_id: scenarioId,
        });
        chatId = chat?.chat_id;
        if (!chatId) throw new Error('Saucepan did not return a temporary chat ID');

        const generation = await request('POST', '/api/v2/chat/generate', {
            chat_id: chatId,
            content: 'hi',
            generation_config: { openaiprovider: { config_id: providerId } },
            active_companion_id: companionId,
            mode: 'user',
            utc_offset_minutes: -new Date().getTimezoneOffset(),
        });
        generationId = generation?.generation_id;

        const captured = await capture.waitForCapture();
        const parsed = parseSaucepanCapturedMessages(captured?.messages);
        result = {
            assembled: {
                'Companion Core': parsed.core,
                'Example Dialogue': parsed.exampleDialogue,
            },
            greeting: parsed.greeting,
        };
    } catch (error) {
        failure = error;
    } finally {
        const attemptCleanup = async (label, action) => {
            try {
                await action();
            } catch {
                cleanupFailures.push(label);
            }
        };
        if (tunnel) {
            await attemptCleanup('Quick Tunnel shutdown', () => tunnel.close());
        }
        if (capture) {
            await attemptCleanup('capture listener shutdown', () => capture.close());
        }
        if (chatId && generationId) {
            await attemptCleanup('generation cancellation', () => request(
                'POST',
                '/api/v2/chat/cancel',
                { chat_id: chatId, generation_id: generationId },
                cleanupTimeoutMs,
            ));
        }
        if (chatId) {
            await attemptCleanup('temporary chat deletion', () => request(
                'DELETE',
                '/api/v1/chat',
                { chat_id: chatId },
                cleanupTimeoutMs,
            ));
        }
        if (providerId) {
            await attemptCleanup('temporary provider deletion', () => request(
                'DELETE',
                '/api/v1/openai_provider/config',
                { config_id: providerId },
                cleanupTimeoutMs,
            ));
        }
    }

    if (failure?.outcomeUnknown) cleanupFailures.unshift('remote request outcome unknown');
    const cleanupWarning = cleanupFailures.length
        ? `Temporary cleanup was incomplete: ${cleanupFailures.join(', ')}`
        : '';
    if (failure) {
        if (cleanupWarning) failure.cleanupWarning = cleanupWarning;
        throw failure;
    }
    return cleanupWarning ? { ...result, cleanupWarning } : result;
}

export function createSaucepanHiddenExtractionHandler({
    getToken,
    extractor = extractSaucepanHiddenDefinition,
} = {}) {
    let busy = false;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const safeErrorPrefixes = [
        'Install cloudflared',
        'This companion does not allow custom providers',
        'Saucepan request timed out',
        'Timed out waiting for cloudflared',
        'Timed out waiting for Saucepan',
        'Captured prompt section markers',
        'Captured prompt is missing',
        'Captured Companion Core is empty',
    ];

    return async function saucepanHiddenExtractionHandler(request, response) {
        const token = getToken?.();
        if (!token) {
            return response.status(401).json({ success: false, error: 'Saucepan login is required' });
        }

        const companionId = request.body?.companionId;
        if (typeof companionId !== 'string' || !uuidPattern.test(companionId)) {
            return response.status(400).json({ success: false, error: 'A valid Saucepan companion ID is required' });
        }
        if (busy) {
            return response.status(409).json({ success: false, error: 'A Saucepan hidden extraction is already running' });
        }

        busy = true;
        try {
            const result = await extractor({ token, companionId });
            return response.json({ success: true, ...result });
        } catch (error) {
            const message = String(error?.message || '');
            const safeMessage = safeErrorPrefixes.some(prefix => message.startsWith(prefix))
                ? message
                : 'Saucepan hidden extraction failed';
            const cleanupWarning = String(error?.cleanupWarning || '');
            const safeCleanupWarning = /^Temporary cleanup was incomplete: (?:(?:remote request outcome unknown|Quick Tunnel shutdown|capture listener shutdown|generation cancellation|temporary chat deletion|temporary provider deletion)(?:, )?)+$/.test(cleanupWarning)
                ? cleanupWarning
                : '';
            return response.status(502).json({
                success: false,
                error: safeMessage,
                ...(safeCleanupWarning ? { cleanupWarning: safeCleanupWarning } : {}),
            });
        } finally {
            busy = false;
        }
    };
}
