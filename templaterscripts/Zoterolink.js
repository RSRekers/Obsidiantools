<%*
const fs = require("fs").promises;
const { execFile } = require("child_process");
const { promisify } = require("util");
const http = require("http");
const execFileAsync = promisify(execFile);

// --- CONFIGURATION ---
const folderPath = "Reading notes"; 
const attachmentsFolder = "Attachments"; 
const pdfAnnotsExePath = "C:\\Path\\To\\pdfannots2json.exe"; // MUST UPDATE THIS PATH!

// Helper to bypass Obsidian's browser CORS using native Node HTTP
function nodeFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                text: data
            }));
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

// Ensure target folders exist
if (!app.vault.getAbstractFileByPath(folderPath)) await app.vault.createFolder(folderPath);
if (!app.vault.getAbstractFileByPath(attachmentsFolder)) await app.vault.createFolder(attachmentsFolder);

let caywRes;
try {
    // Reverted to format=json which successfully triggers the popup
    caywRes = await nodeFetch("http://127.0.0.1:23119/better-bibtex/cayw?format=json", { method: "GET" });
} catch (e) {
    new window.Notice("Zotero not found. Is Zotero running with Better BibTeX?");
    return;
}

if (!caywRes.ok) {
    new window.Notice(`Zotero error: ${caywRes.status}. Check Zotero console.`);
    return;
}

const text = caywRes.text;
if (!text || text === "[]") return; 

const items = JSON.parse(text);
let insertionText = "";

for (const item of items) {
    // Extract the actual Better BibTeX citekey, avoiding the numeric Zotero ID
    const citekey = item.citationKey || item.citekey || item.id;
    const fileName = `@${citekey}.md`;
    const filePath = `${folderPath}/${fileName}`;
    
    // 1. Immediately queue the link for the editor
    insertionText += `[[@${citekey}]] `;

    // 2. If note already exists, SKIP note creation, PDF copy, and extraction
    if (app.vault.getAbstractFileByPath(filePath)) {
        continue;
    }

    // --- NEW NOTE CREATION LOGIC ---
    
    const title = item.title || "Untitled";
    const doi = item.DOI ? (item.DOI.startsWith("http") ? item.DOI : `https://doi.org/${item.DOI}`) : "";
    
    // Support both Zotero internal JSON (creators) and CSL-JSON (author)
    const creators = item.creators || item.author || [];
    let authorsList = creators.map(a => {
        const first = a.given || a.firstName || "";
        const last = a.family || a.lastName || a.name || "";
        return `  - ${first} ${last}`.trim();
    }).join("\n");

    let rpcRes;
    try {
        const rpcBody = JSON.stringify({
            jsonrpc: "2.0",
            method: "item.attachments",
            params: [citekey] // FIX: Single array of parameters
        });
        
        rpcRes = await nodeFetch("http://127.0.0.1:23119/better-bibtex/json-rpc", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json", 
                "Content-Length": Buffer.byteLength(rpcBody) 
            },
            body: rpcBody
        });
    } catch (e) {
        console.error("RPC fetch failed", e);
    }
    
    let pdfFileLink = "";
    let extractedAnnotations = "";

    if (rpcRes && rpcRes.ok) {
        const rpcData = JSON.parse(rpcRes.text);
        const attachments = rpcData.result || [];
        
        const pdf = attachments.find(att => att.path && att.path.endsWith(".pdf"));
        if (pdf) {
            const pdfFileName = `${citekey}.pdf`;
            const destObsidianPath = `${attachmentsFolder}/${pdfFileName}`;
            
            // A. Copy PDF into Vault
            if (!app.vault.getAbstractFileByPath(destObsidianPath)) {
                try {
                    const sourceBuffer = await fs.readFile(pdf.path);
                    await app.vault.createBinary(destObsidianPath, sourceBuffer);
                } catch (err) {
                    console.error("Failed to copy PDF:", err);
                }
            }
            pdfFileLink = `![[${pdfFileName}]]`;

            // B. Extract Annotations
            try {
                const { stdout } = await execFileAsync(pdfAnnotsExePath, [pdf.path]);
                const annotsData = JSON.parse(stdout);
                
                if (annotsData && annotsData.length > 0) {
                    extractedAnnotations = "\n## Annotations\n";
                    for (const annot of annotsData) {
                        if (annot.type === "Highlight" && annot.text) {
                            extractedAnnotations += `> ${annot.text}\n\n`;
                        } else if (annot.type === "Text" && annot.contents) {
                            extractedAnnotations += `- **Note**: ${annot.contents}\n\n`;
                        }
                    }
                }
            } catch (err) {
                console.error("pdfannots2json failed:", err);
            }
        }
    }

    // 3. Create the literature note
    const content = `---
title: "${title.replace(/"/g, '\\"')}"
tags: 
---

${pdfFileLink ? `## PDF Attachment\n${pdfFileLink}` : ""}
${extractedAnnotations}
`;
    
    await app.vault.create(filePath, content);
    new window.Notice(`Created note & copied PDF: ${fileName}`);
}

// 4. Output the link(s) to the active document
tR += insertionText;
%>
