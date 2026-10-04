import express from 'express';
import http from 'http';
import https from 'https';
import { Server } from 'socket.io';
import puppeteerCore from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// ENVIRONMENT & CHROMIUM AUTO-DETECTION
// ==========================================
const IS_TERMUX = process.env.PREFIX && process.env.PREFIX.includes('com.termux') ? true : false;
const IS_RAILWAY = process.env.RAILWAY_ENVIRONMENT ? true : false;
const HOST_ENV = IS_RAILWAY ? 'Railway' : (IS_TERMUX ? 'Termux' : 'Local / Linux');

let CHROMIUM_EXECUTABLE_PATH = undefined;
if (IS_TERMUX) {
    CHROMIUM_EXECUTABLE_PATH = '/data/data/com.termux/files/usr/bin/chromium-browser';
} else if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    CHROMIUM_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH;
}

console.log(`[SYSTEM] Environment: ${HOST_ENV}`);
console.log(`[SYSTEM] Chromium Path: ${CHROMIUM_EXECUTABLE_PATH || 'Default'}`);

const UID_FILE = path.join(__dirname, 'uid.json');
const activeTimers = {};
const systemLogs = [];
const engineStatus = {};
const executionQueue = [];
let currentRunningUid = null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ==========================================
// 🚀 FAST GAME PROXY FORWARDER (Intercepts /)
// ==========================================
app.use((req, res, next) => {
    // Ignore dashboard and API internal paths
    const internalPaths = ['/activate', '/api/', '/socket.io/'];
    if (internalPaths.some(p => req.path.startsWith(p))) {
        return next();
    }

    // Forward everything else to astutech.online efficiently
    const options = {
        hostname: 'version.astutech.online',
        port: 443,
        path: req.url,
        method: req.method,
        headers: {
            ...req.headers,
            host: 'version.astutech.online' // Update host header for target
        }
    };

    const proxyReq = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
        console.error(`[PROXY ERROR] Game request failed: ${err.message}`);
        res.status(502).end();
    });

    // Pipe the raw incoming request directly to the proxy
    req.pipe(proxyReq, { end: true });
});

// JSON body parsers (Only applies to internal paths because proxy catches others first)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ==========================================
// DATA ENGINE (UID.JSON)
// ==========================================
function loadUIDs() {
    if (!fs.existsSync(UID_FILE)) fs.writeFileSync(UID_FILE, JSON.stringify([]), 'utf8');
    try {
        return JSON.parse(fs.readFileSync(UID_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function saveUIDs(data) {
    fs.writeFileSync(UID_FILE, JSON.stringify(data, null, 4), 'utf8');
}

function getPKTTime() {
    return new Date().toLocaleString('en-US', { timeZone: 'Asia/Karachi', hour12: true });
}

function appendLog(msg, type = 'info') {
    const time = getPKTTime();
    let colorClass = 'text-blue-500 dark:text-blue-400';
    if (type === 'success') colorClass = 'text-emerald-500 dark:text-emerald-400';
    if (type === 'error') colorClass = 'text-rose-500 dark:text-rose-400';
    if (type === 'warn') colorClass = 'text-amber-500 dark:text-amber-400';

    const htmlLog = `<div class="mb-2 text-[13px] border-b border-gray-100 dark:border-white/5 pb-2 font-medium tracking-wide">
        <span class="text-gray-400 dark:text-zinc-500 mr-2">[${time}]</span>
        <span class="${colorClass}">${msg}</span>
    </div>`;
    
    systemLogs.push(htmlLog); 
    if (systemLogs.length > 250) systemLogs.shift(); 
    io.emit('new_log', htmlLog); 
    console.log(`[${time}] ${msg.replace(/<[^>]*>?/gm, '')}`);
}

// ==========================================
// RUNTIME AUTOMATION QUEUE
// ==========================================
async function processQueue() {
    if (currentRunningUid || executionQueue.length === 0) return;
    currentRunningUid = executionQueue.shift();
    const target = activeTimers[currentRunningUid];

    if (target && target.autoActivate) { 
        try { 
            await runGhostActivator(currentRunningUid, target.name); 
        } catch (e) { 
            appendLog(`Target ${currentRunningUid} cycle interrupted: ${e.message}`, 'error'); 
        } 
        scheduleNextRun(currentRunningUid); 
    } 
    currentRunningUid = null; 
    processQueue();
}

function scheduleNextRun(uid) {
    if (!activeTimers[uid] || !activeTimers[uid].autoActivate) return;
    const intervalMs = activeTimers[uid].intervalMins * 60 * 1000;
    activeTimers[uid].nextRun = Date.now() + intervalMs;
    clearTimeout(activeTimers[uid].timer);
    activeTimers[uid].timer = setTimeout(() => {
        if (!executionQueue.includes(uid)) executionQueue.push(uid);
        processQueue();
    }, intervalMs);
}

function startUIDCycle(uid, name, intervalMins, autoActivate) {
    if (activeTimers[uid]) clearTimeout(activeTimers[uid].timer);
    activeTimers[uid] = { name, intervalMins, autoActivate, nextRun: Date.now(), timer: null };
    if (autoActivate) {
        if (!executionQueue.includes(uid)) executionQueue.push(uid);
        processQueue();
    }
}

// ==========================================
// BACKGROUND AUTOMATION ENGINE
// ==========================================
async function runGhostActivator(uid, name) {
    if (engineStatus[uid]) return;
    engineStatus[uid] = true;
    let browser = null;
    appendLog(`Engine boot initialized for ${name} (${uid})...`, 'info');

    try { 
        browser = await puppeteer.launch({ 
            args: [ '--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=360,640' ], 
            headless: 'new', 
            executablePath: CHROMIUM_EXECUTABLE_PATH 
        }); 
        
        const page = (await browser.pages())[0] || await browser.newPage(); 
        await page.setViewport({ width: 360, height: 640, isMobile: true, hasTouch: true }); 
        
        await page.evaluateOnNewDocument(() => { window.open = function() { return null; }; }); 
        
        browser.on('targetcreated', async (target) => { 
            if (target.type() === 'page') { 
                try { 
                    const newPage = await target.page(); 
                    if (newPage && newPage.url() !== 'about:blank') { 
                        setTimeout(() => newPage.close().catch(() => {}), 500); 
                        appendLog('Popup ad tab blocked.', 'warn'); 
                    } 
                } catch {} 
            } 
        }); 
        
        await page.setRequestInterception(true); 
        page.on('request', req => { 
            const rType = req.resourceType(); 
            const urlStr = req.url().toLowerCase(); 
            if (rType === 'media') return req.abort(); 
            if (req.isNavigationRequest() && req.frame() === page.mainFrame()) { 
                if (!urlStr.includes('unlockffbeta.com') && !urlStr.includes('google.com')) { return req.abort('aborted'); } 
            } 
            req.continue(); 
        }); 
        
        page.on('dialog', async dialog => { await dialog.dismiss(); }); 
        await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'); 
        await page.goto('https://unlockffbeta.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }); 
        appendLog('Page loaded. Processing flow...', 'info'); 
        
        let attempts = 0; let uidInjected = false; 
        
        while (attempts < 45) { 
            attempts++; 
            const allPages = await browser.pages(); 
            if (allPages.length > 1) { 
                for (let i = 0; i < allPages.length; i++) { 
                    if (allPages[i] !== page) await allPages[i].close().catch(() => {}); 
                } 
                await page.bringToFront(); 
            } 
            
            const popupDestroyed = await page.evaluate(() => { 
                let killed = false; 
                document.querySelectorAll('div, iframe, section').forEach(el => { 
                    const text = el.innerText ? el.innerText.toLowerCase() : ''; 
                    const z = parseInt(window.getComputedStyle(el).zIndex || '0'); 
                    if (text.includes('bonus available') || text.includes('congratulations') || (z > 999 && (el.id.includes('ad') || el.className.includes('ad')))) { 
                        el.remove(); killed = true; 
                    } 
                }); 
                return killed; 
            }); 
            if (popupDestroyed) appendLog('Spam overlay destroyed.', 'warn'); 
            
            await page.evaluate(() => { 
                const reloadBtn = Array.from(document.querySelectorAll('button, a, div[role="button"]')).find(b => b.innerText && b.innerText.toLowerCase().includes('i fixed it')); 
                if (reloadBtn) reloadBtn.click(); 
            }); 
            
            const isInitializing = await page.evaluate(() => { 
                const text = document.body.innerText ? document.body.innerText.toLowerCase() : ''; 
                return (text.includes('please wait') || text.includes('initializing...')) && !text.includes('access granted'); 
            }); 
            if (isInitializing) { await new Promise(r => setTimeout(r, 2000)); continue; } 
            
            const resultData = await page.evaluate(() => { 
                const result = { success: false, timeStr: "1h 0m 0s", h: 0, m: 0, s: 0 }; 
                const text = document.body.innerText ? document.body.innerText.toLowerCase() : ""; 
                if (text.includes('step ') && text.includes(' of ')) return result; 
                if (text.includes('access granted') || text.includes('successfully') || text.includes('expires in')) { 
                    result.success = true; 
                    const hMatch = text.match(/(\d+)\s*h/i); 
                    const mMatch = text.match(/(\d+)\s*m/i); 
                    const sMatch = text.match(/(\d+)\s*s/i); 
                    if (hMatch) result.h = parseInt(hMatch[1]); 
                    if (mMatch) result.m = parseInt(mMatch[1]); 
                    if (sMatch) result.s = parseInt(sMatch[1]); 
                    if (result.h === 0 && result.m === 0 && result.s === 0) { 
                        const fallback = text.match(/(\d+)\s*min/i); 
                        if (fallback) result.m = parseInt(fallback[1]); else result.m = 60; 
                    } 
                    result.timeStr = `${result.h}h ${result.m}m ${result.s}s`; 
                } 
                return result; 
            }); 
            
            if (resultData.success) { 
                appendLog(`✅ Activation Successful! Time Granted: ${resultData.timeStr}`, 'success'); 
                let extractedMs = (resultData.h * 3600000) + (resultData.m * 60000) + (resultData.s * 1000); 
                if (extractedMs < 60000) extractedMs = 3600000; 
                let safeIntervalMs = extractedMs - (5 * 60000); 
                if (safeIntervalMs < 60000) safeIntervalMs = 60000; 
                
                if (activeTimers[uid]) { 
                    activeTimers[uid].intervalMins = Math.floor(safeIntervalMs / 60000); 
                    appendLog(`Auto-renew scheduled in ${activeTimers[uid].intervalMins} mins.`, 'info'); 
                } 
                break; 
            } 
            
            const isBlocked = await page.evaluate(() => { 
                const text = document.body.innerText ? document.body.innerText.toLowerCase() : ""; 
                return text.includes('invalid id'); 
            }); 
            if (isBlocked) { throw new Error("Blocked by Target (Invalid ID)"); } 
            
            if (!uidInjected) { 
                const injected = await page.evaluate((val) => { 
                    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"])')); 
                    if (inputs.length > 0 && inputs[0].value !== val) { 
                        inputs[0].focus(); inputs[0].value = val; 
                        inputs[0].dispatchEvent(new Event('input', { bubbles: true })); 
                        inputs[0].dispatchEvent(new Event('change', { bubbles: true })); 
                        return true; 
                    } 
                    return false; 
                }, uid); 
                if (injected) { 
                    uidInjected = true; 
                    appendLog('Target UID injected via DOM events.', 'info'); 
                    await new Promise(r => setTimeout(r, 1000)); 
                } 
            } 
            
            const clicked = await page.evaluate(() => { 
                const closeWords = ['close', 'x', 'skip ad', 'no thanks']; 
                const targets = ['continue without discord', 'continue (an ad will open)', 'continue', 'proceed', 'next', 'submit']; 
                const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"], span')); 
                for (let btn of buttons) { 
                    if (!btn || typeof btn.innerText !== 'string') continue; 
                    const text = btn.innerText.toLowerCase().trim(); 
                    if (btn.offsetHeight > 0 && window.getComputedStyle(btn).display !== 'none') { 
                        if (closeWords.includes(text) || (text === 'x' && btn.clientWidth < 50)) { 
                            btn.scrollIntoView({ behavior: 'instant', block: 'center' }); 
                            if (typeof btn.click === 'function') btn.click(); 
                            return "Closed Ad (" + text + ")"; 
                        } 
                    } 
                } 
                for (let btn of buttons) { 
                    if (!btn || typeof btn.innerText !== 'string') continue; 
                    const text = btn.innerText.toLowerCase().trim(); 
                    if (btn.offsetHeight > 0 && window.getComputedStyle(btn).display !== 'none') { 
                        if (targets.some(t => text === t || text.includes(t))) { 
                            btn.scrollIntoView({ behavior: 'instant', block: 'center' }); 
                            if (typeof btn.click === 'function') btn.click(); 
                            return text; 
                        } 
                    } 
                } 
                return null; 
            }); 
            
            if (clicked) { 
                appendLog(`Action Executed: "${clicked}"`, 'info'); 
                await new Promise(r => setTimeout(r, 2000)); 
            } else { 
                await new Promise(r => setTimeout(r, 1000)); 
            } 
        } 
    } catch (e) { 
        throw e; 
    } finally { 
        if (browser) await browser.close(); 
        engineStatus[uid] = false; 
        appendLog(`Engine process completed for ${uid}.`, 'info'); 
    }
}

// ==========================================
// HIGH-END UI DESIGN (HTML/CSS/JS INJECTION)
// ==========================================
const uiTemplate = `
<!DOCTYPE html>
<html lang="en" class="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Romeo Engine</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="/socket.io/socket.io.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    fontFamily: { sans: ['Inter', 'sans-serif'] },
                    animation: {
                        'fade-in': 'fadeIn 0.5s ease-out forwards',
                        'slide-up': 'slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards'
                    },
                    keyframes: {
                        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
                        slideUp: { '0%': { opacity: '0', transform: 'translateY(20px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } }
                    }
                }
            }
        }
    </script>
    <style>
        body { font-family: 'Inter', sans-serif; -webkit-tap-highlight-color: transparent; }
        
        .glass {
            background: rgba(255, 255, 255, 0.6);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.5);
        }
        .dark .glass {
            background: rgba(17, 24, 39, 0.7);
            border: 1px solid rgba(255, 255, 255, 0.08);
        }

        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(156, 163, 175, 0.3); border-radius: 10px; }
        .dark ::-webkit-scrollbar-thumb { background: rgba(75, 85, 99, 0.5); }
        
        .toggle-checkbox:checked { right: 0; border-color: #3b82f6; }
        .toggle-checkbox:checked + .toggle-label { background-color: #3b82f6; }
        .toggle-checkbox:checked + .toggle-label .dot { transform: translateX(20px); }
    </style>
</head>
<body class="bg-slate-50 dark:bg-gray-950 text-slate-800 dark:text-gray-100 min-h-screen transition-colors duration-500 overflow-x-hidden relative">
    
    <div class="fixed top-[-10%] left-[-10%] w-[40vw] h-[40vw] bg-indigo-400/20 dark:bg-indigo-600/20 rounded-full blur-[100px] pointer-events-none z-0"></div>
    <div class="fixed bottom-[-10%] right-[-10%] w-[50vw] h-[50vw] bg-fuchsia-400/20 dark:bg-fuchsia-600/20 rounded-full blur-[120px] pointer-events-none z-0"></div>

    <div class="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <header class="flex justify-between items-center mb-10 animate-fade-in">
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/30 text-white font-bold text-xl">
                    R
                </div>
                <div>
                    <h1 class="text-2xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-gray-900 to-gray-600 dark:from-white dark:to-gray-400">Romeo Engine</h1>
                    <p class="text-xs text-gray-500 dark:text-gray-400 font-medium tracking-wide">HOST: <span class="text-indigo-500 dark:text-indigo-400">SYSTEM_ENV_PLACEHOLDER</span></p>
                </div>
            </div>
            <button onclick="toggleTheme()" class="p-2.5 rounded-full glass hover:scale-105 transition-transform shadow-sm">
                <svg id="theme-icon" class="w-5 h-5 text-gray-700 dark:text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path>
                </svg>
            </button>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
            <div class="lg:col-span-5 space-y-6 animate-slide-up" style="animation-delay: 0.1s;">
                <div class="glass rounded-3xl p-6 shadow-xl shadow-gray-200/50 dark:shadow-none">
                    <h2 class="text-lg font-semibold mb-4 flex items-center gap-2">
                        <svg class="w-5 h-5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg>
                        Deploy New Node
                    </h2>
                    <form id="add-form" class="space-y-4">
                        <div>
                            <label class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 ml-1">Target Identifier</label>
                            <input type="text" id="name" required placeholder="e.g., Main Account" class="w-full bg-white/50 dark:bg-black/30 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all">
                        </div>
                        <div>
                            <label class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 ml-1">UID Input</label>
                            <input type="text" id="uid" required placeholder="123456789" class="w-full bg-white/50 dark:bg-black/30 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all">
                        </div>
                        <div>
                            <label class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 ml-1">Activation Cycle (Minutes)</label>
                            <input type="number" id="interval" value="40" class="w-full bg-white/50 dark:bg-black/30 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all">
                        </div>
                        <button type="submit" class="w-full mt-2 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white rounded-xl py-3.5 text-sm font-semibold shadow-lg shadow-indigo-500/25 transition-all transform hover:-translate-y-0.5">
                            Launch Activation
                        </button>
                    </form>
                </div>

                <div class="glass rounded-3xl p-4 shadow-xl shadow-gray-200/50 dark:shadow-none flex flex-col h-[400px]">
                    <div class="flex justify-between items-center mb-3 px-2">
                        <h2 class="text-sm font-semibold flex items-center gap-2">
                            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> Engine Output
                        </h2>
                    </div>
                    <div class="relative flex-1 bg-white/50 dark:bg-black/40 rounded-2xl overflow-hidden border border-gray-100 dark:border-gray-800">
                        <div id="logs-view" class="absolute inset-0 p-4 overflow-y-auto font-mono text-sm leading-relaxed"></div>
                    </div>
                </div>
            </div>

            <div class="lg:col-span-7 animate-slide-up" style="animation-delay: 0.2s;">
                <div class="flex justify-between items-center mb-6 pl-2">
                    <h2 class="text-xl font-semibold tracking-tight">Active Nodes</h2>
                    <span id="node-count" class="bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 px-3 py-1 rounded-full text-xs font-bold">0 Online</span>
                </div>
                
                <div id="nodes-container" class="space-y-4">
                    <!-- Cards injected via JS -->
                </div>
            </div>
        </div>
    </div>

    <script>
        const socket = io();
        let uiData = {};

        function initTheme() {
            if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                document.documentElement.classList.add('dark');
            } else {
                document.documentElement.classList.remove('dark');
            }
            updateThemeIcon();
        }
        
        function toggleTheme() {
            document.documentElement.classList.toggle('dark');
            localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
            updateThemeIcon();
        }
        
        function updateThemeIcon() {
            const isDark = document.documentElement.classList.contains('dark');
            const icon = document.getElementById('theme-icon');
            icon.innerHTML = isDark 
                ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />'
                : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />';
        }
        initTheme();

        document.getElementById('add-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = e.target.querySelector('button');
            const origText = btn.innerText;
            btn.innerText = 'Deploying...';
            
            await fetch('/api/target/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: document.getElementById('name').value,
                    uid: document.getElementById('uid').value,
                    interval: document.getElementById('interval').value
                })
            });
            
            e.target.reset();
            btn.innerText = origText;
        });

        async function toggleStatus(uid, status) {
            await fetch('/api/target/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uid, status })
            });
        }

        socket.on('init_logs', (logs) => {
            const lv = document.getElementById('logs-view');
            lv.innerHTML = logs.join('');
            lv.scrollTop = lv.scrollHeight;
        });

        socket.on('new_log', (log) => {
            const lv = document.getElementById('logs-view');
            lv.innerHTML += log;
            lv.scrollTop = lv.scrollHeight;
        });

        socket.on('update_ui', (data) => {
            const container = document.getElementById('nodes-container');
            const uids = Object.keys(data);
            
            document.getElementById('node-count').innerText = uids.length + " Online";

            Array.from(container.children).forEach(el => {
                if(!uids.includes(el.id.replace('card-', ''))) el.remove();
            });

            uids.forEach(uid => {
                const info = data[uid];
                let card = document.getElementById('card-' + uid);
                
                if(!card) {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'glass p-5 rounded-2xl flex items-center justify-between mb-3 shadow-sm border border-gray-100 dark:border-white/5';
                    wrapper.id = 'card-' + uid;
                    
                    wrapper.innerHTML = \`
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 rounded-2xl flex items-center justify-center bg-gray-100/50 dark:bg-gray-800/50 shadow-inner">
                                <svg class="w-6 h-6 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                            </div>
                            <div>
                                <h3 class="text-base font-bold text-gray-900 dark:text-white line-clamp-1">\${info.name}</h3>
                                <p class="text-xs font-mono text-gray-500 dark:text-gray-400 mt-0.5">\${uid}</p>
                            </div>
                        </div>
                        
                        <div class="flex items-center gap-5">
                            <div class="text-right hidden sm:block">
                                <p class="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-0.5">Status</p>
                                <p id="time-\${uid}" class="text-sm font-bold \${info.isRunning ? 'text-emerald-500 animate-pulse' : 'text-gray-700 dark:text-gray-200'}">\${info.isRunning ? 'Running...' : info.remaining}</p>
                            </div>
                            
                            <label class="flex items-center cursor-pointer relative">
                              <input type="checkbox" onchange="toggleStatus('\${uid}', this.checked)" \${info.autoActivate ? 'checked' : ''} class="sr-only toggle-checkbox">
                              <div class="toggle-label w-11 h-6 bg-gray-200 dark:bg-gray-700 rounded-full transition-colors relative">
                                <div class="dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform"></div>
                              </div>
                            </label>
                        </div>
                    \`;
                    container.appendChild(wrapper);
                } else {
                    const timeEl = document.getElementById('time-' + uid);
                    if(timeEl) {
                        timeEl.innerText = info.isRunning ? 'Running...' : info.remaining;
                        timeEl.className = \`text-sm font-bold \${info.isRunning ? 'text-emerald-500 animate-pulse' : 'text-gray-700 dark:text-gray-200'}\`;
                    }
                    
                    const cb = card.querySelector('.toggle-checkbox');
                    if(cb && cb.checked !== info.autoActivate) {
                        cb.checked = info.autoActivate;
                    }
                }
            });
        });
    </script>
</body>
</html>
`; 

// Changed UI route from / to /activate
app.get('/activate', (req, res) => {
    res.send(uiTemplate.replace('SYSTEM_ENV_PLACEHOLDER', HOST_ENV));
});

// ==========================================
// API HANDLERS
// ==========================================
app.post('/api/target/add', (req, res) => {
    const { name, uid, interval } = req.body;
    let users = loadUIDs();
    if (!users.find(u => u.uid === uid)) {
        users.push({ name, uid, interval_mins: parseInt(interval) || 40, auto_activate: true });
        saveUIDs(users);
        startUIDCycle(uid, name, parseInt(interval) || 40, true);
        appendLog(`New node onboarded: ${name} (${uid})`, 'success');
    }
    res.json({ success: true });
});

app.post('/api/target/toggle', (req, res) => {
    const { uid, status } = req.body;
    let users = loadUIDs();
    const user = users.find(u => u.uid === uid);
    if (user) {
        user.auto_activate = status;
        saveUIDs(users);
    }
    if (activeTimers[uid]) {
        activeTimers[uid].autoActivate = status;
        if (!status) clearTimeout(activeTimers[uid].timer);
        else scheduleNextRun(uid);
    }
    res.json({ success: true });
});

// ==========================================
// SOCKET & BACKGROUND SYNC
// ==========================================
io.on('connection', (socket) => {
    socket.emit('init_logs', systemLogs);
});

setInterval(() => {
    const uiData = {};
    const now = Date.now();
    for (const uid in activeTimers) {
        const timer = activeTimers[uid];
        const diff = Math.max(0, timer.nextRun - now);
        let remainingStr = `${Math.floor(diff / 60000)}m ${Math.floor((diff % 60000) / 1000)}s`;
        if (diff <= 0) remainingStr = 'Booting...';

        uiData[uid] = { 
            name: timer.name, 
            remaining: remainingStr, 
            autoActivate: timer.autoActivate, 
            isRunning: engineStatus[uid] || false 
        }; 
    } 
    io.emit('update_ui', uiData);
}, 1000);

setTimeout(() => {
    const users = loadUIDs();
    if (users.length > 0) {
        appendLog(`Syncing ${users.length} targets from uid.json...`, 'info');
        users.forEach((u, idx) => setTimeout(() => startUIDCycle(u.uid, u.name, u.interval_mins, u.auto_activate), idx * 2500));
    }
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n================================`);
    console.log(`> ROMEO MATRIX SERVER ONLINE`);
    console.log(`> UI PANEL: http://localhost:${PORT}/activate`);
    console.log(`> GAME PROXY RUNNING ON: /`);
    console.log(`> HOST: ${HOST_ENV}`);
    console.log(`================================\n`);
});
