import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, useApp, useStdin } from 'ink';
import Image, { TerminalInfoProvider } from 'ink-picture';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';

const execAsync = promisify(exec);

const IMAGES_DIR = path.join(process.cwd(), 'images');
const TMP_DIR    = os.tmpdir();

// ── Types ─────────────────────────────────────────────────────────────────────

type EditOp = 'grayscale' | 'rotate' | 'flip' | 'blur' | 'original';
type AiOp   = Record<string, unknown>;

const EDITS: { key: string; op: EditOp; label: string }[] = [
	{ key: 'g', op: 'grayscale', label: 'G  Grayscale'   },
	{ key: 'r', op: 'rotate',    label: 'R  Rotate 90°'  },
	{ key: 'f', op: 'flip',      label: 'F  Flip'        },
	{ key: 'b', op: 'blur',      label: 'B  Blur'        },
	{ key: 'o', op: 'original',  label: 'O  Original'    },
];

// ── AI transform (runs outside React) ────────────────────────────────────────

const AI_SYSTEM_PROMPT = `You are a sharp.js image editing assistant.
Given a user request, output ONLY a valid JSON array of operations — no markdown, no explanation.

Supported ops (exact field names):
{"op":"grayscale"}
{"op":"blur","sigma":N}              (sigma 0.3–1000)
{"op":"rotate","angle":N}           (degrees)
{"op":"flip"}                        (vertical)
{"op":"flop"}                        (horizontal)
{"op":"negate"}
{"op":"normalize"}
{"op":"modulate","brightness":N,"saturation":N,"hue":N}  (multipliers, 1=no change)
{"op":"tint","r":N,"g":N,"b":N}     (0–255)
{"op":"sharpen"}
{"op":"gamma","gamma":N}            (1.0–3.0)
{"op":"linear","a":N,"b":N}         (output = a*input + b)

Output ONLY the JSON array.`;

async function runAiTransform(imagePath: string, prompt: string): Promise<string> {
	const full = `${AI_SYSTEM_PROMPT}\n\nUser request: ${prompt}`;
	const { stdout } = await execAsync(`claude -p ${JSON.stringify(full)}`, { timeout: 30_000 });

	const match = stdout.match(/\[[\s\S]*?\]/);
	if (!match) throw new Error(`No JSON in response: ${stdout.slice(0, 120)}`);

	const ops: AiOp[] = JSON.parse(match[0]);
	const tmpOut = path.join(TMP_DIR, `ink-ai-${Date.now()}.png`);
	let pipeline = sharp(imagePath);

	for (const op of ops) {
		switch (op.op) {
			case 'grayscale': pipeline = pipeline.grayscale(); break;
			case 'blur':      pipeline = pipeline.blur((op.sigma as number) ?? 3); break;
			case 'rotate':    pipeline = pipeline.rotate((op.angle as number) ?? 90); break;
			case 'flip':      pipeline = pipeline.flip(); break;
			case 'flop':      pipeline = pipeline.flop(); break;
			case 'negate':    pipeline = pipeline.negate(); break;
			case 'normalize': pipeline = pipeline.normalize(); break;
			case 'sharpen':   pipeline = pipeline.sharpen(); break;
			case 'modulate':  pipeline = pipeline.modulate({
				brightness: op.brightness as number | undefined,
				saturation: op.saturation as number | undefined,
				hue:        op.hue        as number | undefined,
			}); break;
			case 'tint':      pipeline = pipeline.tint({ r: op.r as number, g: op.g as number, b: op.b as number }); break;
			case 'gamma':     pipeline = pipeline.gamma((op.gamma as number) ?? 2.2); break;
			case 'linear':    pipeline = pipeline.linear(op.a as number | undefined, op.b as number | undefined); break;
		}
	}

	await pipeline.toFile(tmpOut);
	return tmpOut;
}

// ── Small UI helpers ──────────────────────────────────────────────────────────

const Divider: React.FC = () => (
	<Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderDimColor />
);

// ── App ───────────────────────────────────────────────────────────────────────

const App: React.FC = () => {
	const { exit }            = useApp();
	const { stdin, setRawMode } = useStdin();

	const [status, setStatus]           = useState('Waiting for image…');
	const [hasClipboard, setHasClipboard] = useState(false);
	const [recentFiles, setRecentFiles] = useState<string[]>([]);
	const [inputPath, setInputPath]     = useState('');
	const [previewSrc, setPreviewSrc]   = useState('');
	const [editMode, setEditMode]       = useState(false);
	const [aiMode, setAiMode]           = useState(false);
	const [aiPrompt, setAiPrompt]       = useState('');
	const [aiBusy, setAiBusy]           = useState(false);
	const rawSupported   = stdin.isTTY;
	const listenerRef    = useRef(false);
	const savedImagePath = useRef('');
	const tmpEditPath    = useRef('');

	// ── Tmp management ───────────────────────────────────────────────────
	const clearTmp = useCallback(() => {
		if (tmpEditPath.current && fs.existsSync(tmpEditPath.current)) {
			try { fs.unlinkSync(tmpEditPath.current); } catch {}
			tmpEditPath.current = '';
		}
	}, []);

	useEffect(() => {
		process.on('exit', clearTmp);
		return () => { process.off('exit', clearTmp); };
	}, [clearTmp]);

	// ── Manual edits ─────────────────────────────────────────────────────
	const applyEdit = useCallback(async (op: EditOp) => {
		if (!savedImagePath.current) return;
		clearTmp();

		if (op === 'original') {
			setPreviewSrc(savedImagePath.current);
			setStatus('Showing original');
			return;
		}

		try {
			const tmpOut = path.join(TMP_DIR, `ink-edit-${Date.now()}.png`);
			let pipeline = sharp(savedImagePath.current);
			switch (op) {
				case 'grayscale': pipeline = pipeline.grayscale();  break;
				case 'rotate':    pipeline = pipeline.rotate(90);   break;
				case 'flip':      pipeline = pipeline.flop();       break;
				case 'blur':      pipeline = pipeline.blur(4);      break;
			}
			await pipeline.toFile(tmpOut);
			tmpEditPath.current = tmpOut;
			setPreviewSrc(tmpOut);
			setStatus(`Applied: ${op}`);
		} catch (err) {
			setStatus(`Edit error: ${err instanceof Error ? err.message : err}`);
		}
	}, [clearTmp]);

	const saveEdit = useCallback(() => {
		if (!tmpEditPath.current || !fs.existsSync(tmpEditPath.current)) {
			setStatus('Nothing to save');
			return;
		}
		const base     = path.basename(savedImagePath.current, path.extname(savedImagePath.current));
		const ext      = path.extname(savedImagePath.current);
		const destName = `${base}-edited${ext}`;
		const destPath = path.join(IMAGES_DIR, destName);
		fs.copyFileSync(tmpEditPath.current, destPath);
		clearTmp();
		savedImagePath.current = destPath;
		setRecentFiles(prev => [destName, ...prev.filter(f => f !== destName)].slice(0, 5));
		setStatus(`Saved → ${destName}`);
		setEditMode(false);
	}, [clearTmp]);

	// ── AI transform ─────────────────────────────────────────────────────
	const submitAiPrompt = useCallback(async (prompt: string) => {
		if (!savedImagePath.current || !prompt.trim()) return;
		setAiMode(false);
		setAiPrompt('');
		setAiBusy(true);
		setStatus(`Claude: "${prompt}"…`);
		clearTmp();
		try {
			const tmpOut = await runAiTransform(savedImagePath.current, prompt);
			tmpEditPath.current = tmpOut;
			setPreviewSrc(tmpOut);
			setEditMode(true);
			setStatus(`AI done — Enter to save, X to discard`);
		} catch (err) {
			setStatus(`AI error: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setAiBusy(false);
		}
	}, [clearTmp]);

	// ── Clipboard ────────────────────────────────────────────────────────
	const getClipboardPath = (): string | null => {
		try {
			const s = execSync(
				`osascript -e 'tell app "System Events" to get POSIX path of (alias (clipboard info for «class furl» as string))' 2>/dev/null`,
				{ encoding: 'utf8', timeout: 5000 }
			).trim();
			if (s && fs.existsSync(s)) return s;
		} catch {}
		try {
			const s = execSync('pbpaste', { encoding: 'utf8' }).trim();
			if (s && !s.includes('\n') && fs.existsSync(s)) return s;
		} catch {}
		return null;
	};

	const checkClipboard = () => setHasClipboard(getClipboardPath() !== null);

	// ── Load image ───────────────────────────────────────────────────────
	const saveImage = useCallback(async (sourcePath: string): Promise<boolean> => {
		try {
			const abs = path.resolve(sourcePath);
			if (!fs.existsSync(abs))          { setStatus(`Not found: ${sourcePath}`); return false; }
			if (!fs.statSync(abs).isFile())    { setStatus('Not a file'); return false; }
			const ext = path.extname(abs).toLowerCase();
			if (!['.png','.jpg','.jpeg','.gif','.bmp','.webp','.tiff'].includes(ext)) {
				setStatus(`Unsupported: ${ext}`); return false;
			}
			const name = path.basename(abs);
			const dest = path.join(IMAGES_DIR, name);
			fs.copyFileSync(abs, dest);
			savedImagePath.current = dest;
			setStatus(`Loaded: ${name}`);
			setRecentFiles(prev => [name, ...prev.filter(f => f !== name)].slice(0, 5));
			checkClipboard();
			setInputPath('');
			setEditMode(false);
			setAiMode(false);
			setPreviewSrc(dest);
			return true;
		} catch (err) {
			setStatus(`Error: ${err instanceof Error ? err.message : 'Unknown'}`);
			return false;
		}
	}, []);

	const pasteClipboard = useCallback(() => {
		const p = getClipboardPath();
		if (p) saveImage(p); else setStatus('No image in clipboard');
	}, [saveImage]);

	const commitInputPath = useCallback(() => {
		if (inputPath) saveImage(inputPath);
		setInputPath('');
	}, [inputPath, saveImage]);

	// ── Init ─────────────────────────────────────────────────────────────
	useEffect(() => {
		if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
		checkClipboard();
		const arg = process.argv.slice(2).find(a => !a.startsWith('-'));
		if (arg) saveImage(arg);
	}, []);

	// ── Key handler ──────────────────────────────────────────────────────
	useEffect(() => {
		if (!rawSupported) {
			const h = (c: Buffer) => { const t = c.toString().trim(); if (t && fs.existsSync(t)) saveImage(t); };
			stdin.on('data', h);
			return () => { stdin.off('data', h); };
		}

		if (listenerRef.current) return;
		listenerRef.current = true;

		let pasteBuffer = '';
		let inPaste     = false;
		setRawMode(true);
		process.stdout.write('\x1b[?2004h');

		const handle = (chunk: Buffer) => {
			const key = chunk.toString();

			// Bracketed paste
			if (key.includes('\x1b[200~')) {
				inPaste = true; pasteBuffer = '';
				const after = key.slice(key.indexOf('\x1b[200~') + 6);
				if (after.includes('\x1b[201~')) {
					inPaste = false;
					const clean = after.slice(0, after.indexOf('\x1b[201~')).trim().replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ');
					if (clean && !aiMode) saveImage(clean);
				} else { pasteBuffer = after; }
				return;
			}
			if (inPaste) {
				if (key.includes('\x1b[201~')) {
					pasteBuffer += key.slice(0, key.indexOf('\x1b[201~'));
					inPaste = false;
					const clean = pasteBuffer.trim().replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ');
					pasteBuffer = '';
					if (clean && !aiMode) saveImage(clean);
				} else { pasteBuffer += key; }
				return;
			}

			if (key === '\x03' || key === '\x04') { exit(); process.exit(0); }

			// ── AI prompt mode ────────────────────────────────────────────
			if (aiMode) {
				if (aiBusy) return;
				if (key === '\x1b' || key.toLowerCase() === 'x') {
					setAiMode(false); setAiPrompt('');
					setStatus(savedImagePath.current ? 'Ready' : 'Waiting for image…');
					return;
				}
				if (key === '\r' || key === '\n') { submitAiPrompt(aiPrompt); return; }
				if (key === '\x7f')                { setAiPrompt(p => p.slice(0, -1)); return; }
				if (key.length === 1 && key >= ' ') { setAiPrompt(p => p + key); return; }
				return;
			}

			// ── Edit mode ─────────────────────────────────────────────────
			if (editMode) {
				if (key === '\x1b' || key.toLowerCase() === 'x') {
					clearTmp(); setPreviewSrc(savedImagePath.current);
					setEditMode(false); setStatus('Discarded');
					return;
				}
				if (key === '\r' || key === '\n') { saveEdit(); return; }
				// Allow entering AI mode from edit mode
				if (key.toLowerCase() === 'a') {
					if (savedImagePath.current) { setAiMode(true); setAiPrompt(''); }
					return;
				}
				const ed = EDITS.find(e => e.key === key.toLowerCase());
				if (ed) applyEdit(ed.op);
				return;
			}

			// ── Normal mode ───────────────────────────────────────────────
			if (key.toLowerCase() === 'p') { pasteClipboard(); return; }
			if (key.toLowerCase() === 'e') {
				if (savedImagePath.current) { setEditMode(true); setStatus('Edit mode'); }
				else setStatus('Load an image first');
				return;
			}
			if (key.toLowerCase() === 'a') {
				if (savedImagePath.current) { setAiMode(true); setAiPrompt(''); setStatus('Describe the transformation…'); }
				else setStatus('Load an image first');
				return;
			}
			if (key === '\r' || key === '\n') { commitInputPath(); return; }
			if (key === '\x7f')               { setInputPath(p => p.slice(0, -1)); return; }
			if (/^[\x20-\x7e]$/.test(key))   { setInputPath(p => p + key); return; }
		};

		stdin.setEncoding('utf8');
		stdin.on('data', handle);
		return () => {
			listenerRef.current = false;
			process.stdout.write('\x1b[?2004l');
			stdin.off('data', handle);
			setRawMode(false);
		};
	}, [rawSupported, stdin, setRawMode,
	    aiMode, aiPrompt, aiBusy, editMode,
	    pasteClipboard, commitInputPath, saveImage, applyEdit, saveEdit, submitAiPrompt, exit, clearTmp]);

	// ── Derived ───────────────────────────────────────────────────────────
	const hasImage    = Boolean(savedImagePath.current);
	const statusColor = aiBusy || status.startsWith('Claude')     ? 'yellow'
	                  : status.startsWith('Saved') || status.startsWith('AI done') || status.startsWith('Loaded') ? 'green'
	                  : status.startsWith('Error') || status.startsWith('Not')      ? 'red'
	                  : 'white';

	// ── Render ────────────────────────────────────────────────────────────
	return (
		<Box flexDirection="column">

			{/* ── Header ─────────────────────────────────────────────────── */}
			<Box
				flexDirection="row"
				justifyContent="space-between"
				alignItems="center"
				paddingX={2}
				paddingY={1}
				borderStyle="single"
				borderTop={false}
				borderLeft={false}
				borderRight={false}
				borderDimColor
			>
				<Box flexDirection="row" gap={2} alignItems="center">
					<Text bold color="cyan">Ink Image CLI</Text>
					{editMode && !aiMode && <Text bold color="magenta">[ EDIT ]</Text>}
					{aiMode              && <Text bold color="yellow" >[ AI ]</Text>}
					{aiBusy              && <Text bold color="yellow" >[ THINKING… ]</Text>}
				</Box>
				<Text color={statusColor}>{status}</Text>
			</Box>

			{/* ── Full-width image preview ────────────────────────────────── */}
			<Box flexDirection="column" alignItems="center" justifyContent="center" paddingY={1}>
				{previewSrc ? (
					<Image src={previewSrc} width={300} alt="preview" />
				) : (
					<Box flexDirection="column" alignItems="center" gap={1} paddingY={4}>
						<Text dimColor>No image loaded</Text>
						<Text dimColor>Drop a file into the terminal or type a path below</Text>
					</Box>
				)}
			</Box>

			{/* ── Controls bar ───────────────────────────────────────────── */}
			<Box
				flexDirection="column"
				paddingX={2}
				paddingY={1}
				borderStyle="single"
				borderBottom={false}
				borderLeft={false}
				borderRight={false}
				borderDimColor
				gap={1}
			>
				{aiBusy ? (
					<Text color="yellow">⟳  Claude is thinking…</Text>
				) : aiMode ? (
					/* AI prompt input */
					<Box flexDirection="column" gap={1}>
						<Box flexDirection="row" gap={2} alignItems="center">
							<Text bold color="yellow">AI Transform →</Text>
							<Box borderStyle="round" borderColor="yellow" paddingX={1} flexGrow={1}>
								<Text color="yellow">{aiPrompt || ' '}</Text>
								<Text color="yellow">▌</Text>
							</Box>
						</Box>
						<Box flexDirection="row" gap={3}>
							<Text dimColor>e.g. vintage · boost contrast · b&w grain · warmer tones</Text>
							<Text dimColor><Text bold color="white">↵</Text> run  <Text bold color="white">Esc</Text> cancel</Text>
						</Box>
					</Box>
				) : editMode ? (
					/* Edit mode controls */
					<Box flexDirection="row" justifyContent="space-between" alignItems="center">
						<Box flexDirection="row" gap={3}>
							{EDITS.map(e => (
								<Text key={e.op}>
									<Text bold color="white">[{e.key.toUpperCase()}]</Text>
									<Text dimColor> {e.label.slice(3)}</Text>
								</Text>
							))}
						</Box>
						<Box flexDirection="row" gap={2}>
							<Text dimColor><Text bold color="white">↵</Text> save</Text>
							<Text dimColor><Text bold color="white">A</Text> AI</Text>
							<Text dimColor><Text bold color="white">X</Text> discard</Text>
						</Box>
					</Box>
				) : (
					/* Normal mode */
					<Box flexDirection="column" gap={1}>
						{rawSupported ? (
							<Box flexDirection="row" gap={2} alignItems="center">
								<Text dimColor>Path:</Text>
								<Box borderStyle="round" borderColor="gray" paddingX={1} flexGrow={1}>
									<Text>{inputPath || ' '}</Text>
									<Text dimColor>▌</Text>
								</Box>
								<Box flexDirection="row" gap={2}>
									<Text dimColor><Text bold color="white">P</Text> paste</Text>
									{hasImage && <Text dimColor><Text bold color="white">E</Text> edit</Text>}
									{hasImage && <Text dimColor><Text bold color="white">A</Text> AI</Text>}
									{hasClipboard && <Text color="green">✓ clipboard</Text>}
								</Box>
							</Box>
						) : (
							<Text dimColor>npm start -- /path/to/image.png</Text>
						)}
						{recentFiles.length > 0 && (
							<Box flexDirection="row" gap={2}>
								<Text dimColor>Recent:</Text>
								{recentFiles.map((f, i) => <Text key={`${f}-${i}`} color="cyan" dimColor>{f}</Text>)}
							</Box>
						)}
					</Box>
				)}
			</Box>

			{/* ── Footer ─────────────────────────────────────────────────── */}
			<Box flexDirection="row" justifyContent="space-between" paddingX={2}>
				<Text dimColor>{IMAGES_DIR}</Text>
				<Text dimColor>Ctrl+C exit</Text>
			</Box>

		</Box>
	);
};

process.stdin.resume();

render(
	<TerminalInfoProvider>
		<App />
	</TerminalInfoProvider>
);
