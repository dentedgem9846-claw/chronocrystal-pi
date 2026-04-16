#!/usr/bin/env bun
/**
 * Build script that embeds dashboard.html into the server.
 */
import { readFileSync, writeFileSync } from "fs";

// Read the dashboard HTML
const dashboardHtml = readFileSync("./public/dashboard.html", "utf-8");

// Escape for JS string
const escapedHtml = dashboardHtml
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");

// Create a generated file with embedded HTML
const generatedCode = `// Auto-generated - do not edit
export const EMBEDDED_DASHBOARD_HTML = \`${escapedHtml}\`;
`;

writeFileSync("./src/web/generated-dashboard.ts", generatedCode);
console.log("Generated embedded dashboard HTML");