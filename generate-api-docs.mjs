#!/usr/bin/env node

/**
 * Offline API Documentation Generator
 * 
 * Generates API documentation for the Font Object Model by loading the same
 * Python script used in the web app. Saves the output to API.md in the repo root.
 * 
 * Usage:
 *   node generate-api-docs.mjs
 */

import { loadPyodide } from 'pyodide';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function generateAPIDocs() {
    console.log('🔧 Loading Pyodide...');
    
    // Load Pyodide - for Node.js, we don't specify indexURL
    const pyodide = await loadPyodide();
    
    console.log('✅ Pyodide loaded');
    console.log('📄 Loading Python documentation script...');
    
    // Read the Python script from the webapp directory
    const pythonScriptPath = join(__dirname, 'webapp', 'py', 'generate_api_docs.py');
    const pythonCode = readFileSync(pythonScriptPath, 'utf-8');
    
    console.log('🔧 Executing Python script...');
    
    // Create a mock 'window' object in the js module for Node.js environment
    // The Python script imports 'from js import window' but doesn't actually use it
    // in the doc generation - it's only in the example code
    await pyodide.runPython(`
# Create a mock window object
class MockWindow:
    currentFontModel = None

import sys
import js
js.window = MockWindow()
    `);
    
    // Execute the Python module to define the functions
    await pyodide.runPython(pythonCode);
    
    // Call generate_docs() and get the result
    const docs = await pyodide.runPythonAsync(`
docs = generate_docs()
docs
    `);
    
    console.log(`✅ Generated ${docs.length} characters of documentation`);
    
    // Write to API.md in the repo root
    const outputPath = join(__dirname, 'API.md');
    writeFileSync(outputPath, docs, 'utf-8');
    
    console.log(`📝 Documentation saved to: ${outputPath}`);
    console.log('✨ Done!');
}

// Run the generator
generateAPIDocs().catch(error => {
    console.error('❌ Error generating documentation:', error);
    process.exit(1);
});
