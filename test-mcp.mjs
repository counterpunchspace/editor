#!/usr/bin/env node
/**
 * Test script to query the Context Font Editor MCP server
 * This directly communicates with the MCP server via stdio
 */

import { spawn } from "child_process";
import { resolve } from "path";

const mcpServerPath = resolve(process.cwd(), "mcp-server/build/index.js");

console.log("Starting MCP server test...");
console.log("MCP server path:", mcpServerPath);

const mcp = spawn("node", [mcpServerPath], {
  stdio: ["pipe", "pipe", "inherit"],
});

// Initialize connection
const initRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "test-client",
      version: "1.0.0",
    },
  },
};

// List resources
const listResourcesRequest = {
  jsonrpc: "2.0",
  id: 2,
  method: "resources/list",
  params: {},
};

// Read logs
const readLogsRequest = {
  jsonrpc: "2.0",
  id: 3,
  method: "resources/read",
  params: {
    uri: "context://logs/recent",
  },
};

let responseBuffer = "";

mcp.stdout.on("data", (data) => {
  responseBuffer += data.toString();

  // Try to parse complete JSON-RPC messages
  const lines = responseBuffer.split("\n");
  responseBuffer = lines.pop() || ""; // Keep incomplete line

  lines.forEach((line) => {
    if (line.trim()) {
      try {
        const response = JSON.parse(line);
        console.log("\n=== MCP Response ===");
        console.log(JSON.stringify(response, null, 2));

        // Send next request based on what we received
        if (response.id === 1) {
          // After init, list resources
          mcp.stdin.write(JSON.stringify(listResourcesRequest) + "\n");
        } else if (response.id === 2) {
          // After listing resources, read logs
          mcp.stdin.write(JSON.stringify(readLogsRequest) + "\n");
        } else if (response.id === 3) {
          // Got logs, we're done
          console.log("\n=== Test Complete ===");
          mcp.kill();
          process.exit(0);
        }
      } catch (e) {
        console.error("Failed to parse response:", line);
      }
    }
  });
});

mcp.on("error", (err) => {
  console.error("MCP process error:", err);
  process.exit(1);
});

mcp.on("close", (code) => {
  console.log(`MCP process exited with code ${code}`);
});

// Start by sending initialize
console.log("\nSending initialize request...");
mcp.stdin.write(JSON.stringify(initRequest) + "\n");

// Timeout after 5 seconds
setTimeout(() => {
  console.error("\nTest timeout!");
  mcp.kill();
  process.exit(1);
}, 5000);
