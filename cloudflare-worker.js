/**
 * Cloudflare Worker - Anthropic API Proxy
 *
 * Deploy this to Cloudflare Workers to proxy Anthropic API requests
 * and bypass CORS restrictions on GitHub Pages.
 *
 * Setup:
 * 1. Go to https://workers.cloudflare.com/
 * 2. Create a new worker
 * 3. Copy this code
 * 4. Deploy
 * 5. Update the PROXY_URL in ai-assistant.js with your worker URL
 */

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, x-api-key, anthropic-version",
      },
    });
  }

  // Only allow POST
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    // Get headers from the incoming request
    const apiKey = request.headers.get("x-api-key");
    const anthropicVersion =
      request.headers.get("anthropic-version") || "2023-06-01";

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "API key required" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Get the request body
    const body = await request.text();

    // Forward to Anthropic API
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": anthropicVersion,
      },
      body: body,
    });

    // Get response from Anthropic
    const responseData = await response.text();

    // Return with CORS headers
    return new Response(responseData, {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}
