/**
 * App Store Connect → Slack Webhook Worker
 * Receives ASC webhook events and forwards formatted notifications to Slack
 */

export default {
  async fetch(request, env) {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Get raw body for signature verification
    const body = await request.text();

    // Verify Apple signature
    const signatureHeader = request.headers.get('x-apple-signature');
    if (!signatureHeader) {
      return new Response('Missing signature', { status: 401 });
    }

    const isValid = await verifySignature(body, signatureHeader, env.ASC_WEBHOOK_SECRET);
    if (!isValid) {
      return new Response('Invalid signature', { status: 401 });
    }

    // Parse payload
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    // Fetch version info from ASC API if available
    let versionInfo = null;
    const apiUrl = extractApiUrl(payload);
    if (apiUrl && env.ASC_KEY_ID && env.ASC_ISSUER_ID && env.ASC_API_KEY) {
      try {
        versionInfo = await fetchVersionInfo(apiUrl, env);
      } catch (err) {
        console.error('Failed to fetch version info:', err);
      }
    }

    // Format and send to Slack
    const slackMessage = formatSlackMessage(payload, versionInfo);

    try {
      const slackResponse = await fetch(env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackMessage),
      });

      if (!slackResponse.ok) {
        console.error('Slack post failed:', await slackResponse.text());
      }
    } catch (err) {
      console.error('Slack post error:', err);
    }

    // Always return 200 to Apple to prevent retries
    return new Response('OK', { status: 200 });
  },
};

/**
 * Extract API URL from payload relationships
 */
function extractApiUrl(payload) {
  const links = payload.data?.relationships?.instance?.links;
  return links?.self || links?.related || null;
}

/**
 * Fetch version info from ASC API
 */
async function fetchVersionInfo(apiUrl, env) {
  const token = await generateJwt(env.ASC_KEY_ID, env.ASC_ISSUER_ID, env.ASC_API_KEY);

  // Include build and app relationships
  const urlWithInclude = apiUrl.includes('?')
    ? `${apiUrl}&include=build,app`
    : `${apiUrl}?include=build,app`;

  const response = await fetch(urlWithInclude, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`ASC API error: ${response.status}`);
  }

  const data = await response.json();
  const attrs = data.data?.attributes || {};

  // Build number and app ID come from included resources
  let buildNumber = null;
  let appId = null;
  if (data.included) {
    const build = data.included.find((r) => r.type === 'builds');
    buildNumber = build?.attributes?.version || null;

    const app = data.included.find((r) => r.type === 'apps');
    appId = app?.id || null;
  }

  return {
    version: attrs.versionString || null,
    buildNumber: buildNumber,
    appId: appId,
  };
}

/**
 * Generate JWT for ASC API authentication
 */
async function generateJwt(keyId, issuerId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 1200; // 20 minutes

  const header = {
    alg: 'ES256',
    kid: keyId,
    typ: 'JWT',
  };

  const payload = {
    iss: issuerId,
    iat: now,
    exp: exp,
    aud: 'appstoreconnect-v1',
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput)
  );

  const encodedSignature = base64UrlEncode(signature);
  return `${signingInput}.${encodedSignature}`;
}

/**
 * Import PEM private key for signing
 */
async function importPrivateKey(pem) {
  // Remove PEM headers and newlines
  const pemContents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');

  const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

/**
 * Base64 URL encode
 */
function base64UrlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Verify HMAC-SHA256 signature from Apple
 */
async function verifySignature(body, signatureHeader, secret) {
  let receivedSignature = signatureHeader;
  if (signatureHeader.toLowerCase().startsWith('hmacsha256=')) {
    receivedSignature = signatureHeader.slice(11);
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const computedSignature = bufferToHex(signatureBuffer);

  return timingSafeEqual(computedSignature, receivedSignature.toLowerCase());
}

/**
 * Convert ArrayBuffer to hex string
 */
function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Timing-safe string comparison
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Format payload into Slack Block Kit message
 */
function formatSlackMessage(payload, versionInfo) {
  const eventType = payload.data?.type || payload.notificationType || 'UNKNOWN';
  const data = payload.data || payload;
  const state = extractState(data);

  const message = formatEventMessage(eventType, data, payload, versionInfo);

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: message,
      },
    },
  ];

  // Add release button for pending developer release
  if (state === 'PENDING_DEVELOPER_RELEASE' && versionInfo?.appId) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Open in App Store Connect →',
            emoji: true,
          },
          url: `https://appstoreconnect.apple.com/apps/${versionInfo.appId}/distribution/ios/version/inflight`,
          style: 'primary',
        },
      ],
    });
  }

  return { blocks };
}

/**
 * Format event-specific message with emoji
 */
function formatEventMessage(eventType, data, fullPayload, versionInfo) {
  const appName = extractAppName(data) || 'Your App';
  const version = versionInfo?.version || extractVersion(data);
  const buildNumber = versionInfo?.buildNumber || extractBuildNumber(data);
  const state = extractState(data);
  const versionStr = formatVersionInfo(version, buildNumber);

  switch (eventType) {
    // Webhook test ping
    case 'webhookPingCreated':
      return `🏓 *App Store Connect* — Webhook configured successfully`;

    // App version events
    case 'appStoreVersionAppVersionStateUpdated':
    case 'appVersionStateChanged':
    case 'APP_VERSION_STATE_CHANGED': {
      const emoji = getStateEmoji(state);
      const status = humanizeState(state);
      return `${emoji} *${appName}${versionStr}* — ${status}`;
    }

    // Build upload events
    case 'buildUploadStateUpdated':
    case 'buildUploadStateChanged':
    case 'BUILD_UPLOAD_STATE_CHANGED': {
      const emoji = getUploadStateEmoji(state);
      const status = humanizeUploadState(state);
      return `${emoji} *${appName}${versionStr}* — ${status}`;
    }

    // TestFlight beta events
    case 'buildBetaStateChanged':
    case 'BUILD_BETA_STATE_CHANGED': {
      const emoji = getBetaStateEmoji(state);
      const status = humanizeBetaState(state);
      return `${emoji} *${appName}${versionStr}* — ${status}`;
    }

    // TestFlight feedback
    case 'feedbackCreated':
    case 'FEEDBACK_CREATED': {
      const feedback = extractFeedback(data);
      const preview = feedback ? truncate(feedback, 100) : 'New feedback received';
      return `💬 *${appName}* — New TestFlight feedback: "${preview}"`;
    }

    default: {
      const truncatedPayload = truncate(JSON.stringify(fullPayload, null, 2), 2000);
      return `❓ *${appName}* — Unknown event: \`${eventType}\`\n\`\`\`${truncatedPayload}\`\`\``;
    }
  }
}

/**
 * Extract app name from various payload structures
 */
function extractAppName(data) {
  const attrs = data.attributes || {};
  return (
    attrs.appName ||
    attrs.app?.name ||
    data.appName ||
    data.app?.name ||
    data.appMetadata?.name ||
    null
  );
}

/**
 * Extract version string from payload
 */
function extractVersion(data) {
  const attrs = data.attributes || {};
  return (
    attrs.versionString ||
    null
  );
}

/**
 * Extract build number from payload
 */
function extractBuildNumber(data) {
  const attrs = data.attributes || {};
  return (
    attrs.buildNumber ||
    data.buildNumber ||
    data.build?.version ||
    null
  );
}

/**
 * Extract state from payload
 */
function extractState(data) {
  const attrs = data.attributes || {};
  return (
    attrs.newState ||
    attrs.newValue ||
    attrs.state ||
    attrs.appStoreState ||
    attrs.processingState ||
    attrs.betaState ||
    data.state ||
    data.appVersionState ||
    data.buildState ||
    data.betaState ||
    null
  );
}

/**
 * Extract feedback text from payload
 */
function extractFeedback(data) {
  const attrs = data.attributes || {};
  return (
    attrs.comment ||
    attrs.feedback ||
    attrs.text ||
    data.feedback ||
    data.comment ||
    null
  );
}

/**
 * Get emoji for app version states
 */
function getStateEmoji(state) {
  const stateMap = {
    WAITING_FOR_REVIEW: '⏳',
    IN_REVIEW: '🔍',
    READY_FOR_DISTRIBUTION: '✅',
    REJECTED: '❌',
    READY_FOR_REVIEW: '📝',
    PENDING_DEVELOPER_RELEASE: '🎉',
    DEVELOPER_REMOVED_FROM_SALE: '🚫',
    PROCESSING_FOR_APP_STORE: '⚙️',
    PREPARE_FOR_SUBMISSION: '📝',
  };
  return stateMap[state] || '📱';
}

/**
 * Get emoji for build upload states
 */
function getUploadStateEmoji(state) {
  const stateMap = {
    PROCESSING: '⚙️',
    COMPLETE: '🛫',
    FAILED: '❌',
    INVALID: '❌',
    VALID: '✅',
  };
  return stateMap[state] || '⚙️';
}

/**
 * Get emoji for beta/TestFlight states
 */
function getBetaStateEmoji(state) {
  const stateMap = {
    PROCESSING: '⚙️',
    PROCESSING_EXCEPTION: '❌',
    MISSING_EXPORT_COMPLIANCE: '⏳',
    READY_FOR_BETA_TESTING: '🧪',
    IN_BETA_TESTING: '🧪',
    EXPIRED: '⏰',
    READY_FOR_BETA_SUBMISSION: '⏳',
    IN_EXPORT_COMPLIANCE_REVIEW: '🔍',
    BETA_REJECTED: '❌',
    BETA_APPROVED: '✅',
  };
  return stateMap[state] || '🧪';
}

/**
 * Humanize app version state
 */
function humanizeState(state) {
  const stateMap = {
    WAITING_FOR_REVIEW: 'Waiting for review',
    IN_REVIEW: 'In review',
    READY_FOR_DISTRIBUTION: 'Ready for distribution',
    REJECTED: 'Rejected',
    READY_FOR_REVIEW: 'Ready for review',
    PENDING_DEVELOPER_RELEASE: 'Approved! Pending release 🟡',
    DEVELOPER_REMOVED_FROM_SALE: 'Removed by developer',
    PROCESSING_FOR_APP_STORE: 'Processing for App Store',
    PREPARE_FOR_SUBMISSION: 'Preparing for submission',
  };
  return stateMap[state] || state?.toLowerCase().replace(/_/g, ' ') || 'status changed';
}

/**
 * Humanize build upload state
 */
function humanizeUploadState(state) {
  const stateMap = {
    PROCESSING: 'Build processing',
    COMPLETE: 'Build available in TestFlight',
    FAILED: 'Build upload failed',
    INVALID: 'Build invalid',
    VALID: 'Build upload completed',
  };
  return stateMap[state] || `Build ${state?.toLowerCase() || 'updated'}`;
}

/**
 * Humanize beta/TestFlight state
 */
function humanizeBetaState(state) {
  const stateMap = {
    PROCESSING: 'TestFlight processing',
    PROCESSING_EXCEPTION: 'TestFlight processing failed',
    MISSING_EXPORT_COMPLIANCE: 'Missing export compliance',
    READY_FOR_BETA_TESTING: 'Ready for beta testing',
    IN_BETA_TESTING: 'In beta testing',
    EXPIRED: 'Build expired',
    READY_FOR_BETA_SUBMISSION: 'Ready for beta submission',
    IN_EXPORT_COMPLIANCE_REVIEW: 'In export compliance review',
    BETA_REJECTED: 'Beta rejected',
    BETA_APPROVED: 'Beta approved',
  };
  return stateMap[state] || `TestFlight ${state?.toLowerCase().replace(/_/g, ' ') || 'updated'}`;
}

/**
 * Format version + build number string
 */
function formatVersionInfo(version, buildNumber) {
  if (version && buildNumber) {
    return ` v${version} (${buildNumber})`;
  }
  if (version) {
    return ` v${version}`;
  }
  if (buildNumber) {
    return ` (${buildNumber})`;
  }
  return '';
}

/**
 * Truncate string to max length with ellipsis
 */
function truncate(str, maxLength) {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}
