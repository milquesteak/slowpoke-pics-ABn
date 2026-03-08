// ==UserScript==
// @name Slowpoke Pics ABn Blind Test
// @namespace http://tampermonkey.net/
// @version 1.16
// @description Double-blind ABn source comparison testing for slow.pics
// @author milquesteak
// @match https://slow.pics/c/*
// ==/UserScript==

/*
 * Statistical model: Dirichlet-Multinomial, uniform Dirichlet(1,...,1) prior.
 * Each voted frame is an independent draw from a categorical distribution over
 * (no-preference, source 1, ..., source N). Use "no preference" only on
 * discriminable frames where no winner is detectable; skip non-discriminable frames.
 *
 * theta_0 = probability a voted frame yields no preference (tie rate).
 * theta_j = probability source j wins a voted frame (ties included in denominator).
 * phi_j = theta_j / (1 - theta_0): win-rate of source j conditional on the frame
 * being discriminable. Reported as E[phi_j] with 95% posterior prediction interval.
 * Interpretation: "On a randomly chosen discriminable frame, source j would be
 * preferred E[phi_j]% of the time; 95% PI [lo%-hi%]."
 *
 * P(best_j) = P(phi_j > phi_k for all k != j): posterior probability that source j has
 * the highest true win-rate. Computed as the fraction of posterior draws where
 * source j had the largest phi_j. Sum_j P(best_j) = 1, Sum_j E[phi_j] = 1.
 *
 * No-preference votes update theta_0, widening prediction intervals without changing
 * relative ordering. Frames with no vote recorded are excluded entirely from the model.
 * Wide intervals reflect small vote counts; dominated by likelihood after ~N+1 votes.
 */

(function () {
	'use strict';

	// ─── CONSTANTS ───────────────────────────────────────────────────────────────

	const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

	// ─── STATE ───────────────────────────────────────────────────────────────────
	// All state lives in this closure — nothing is written to localStorage or the DOM
	// as data attributes. The shuffleMap in particular is kept off the DOM entirely
	// to prevent accidental exposure via DevTools element inspection.

	const state = {
		active: false,
		phase: 'idle', // 'idle' | 'mask-setup' | 'testing'
		shuffleMap: [], // shuffleMap[blindIdx] = realSourceIdx
		reverseMap: {}, // reverseMap[realSourceIdx] = blindIdx
		votes: {}, // votes[frameIdx] = blindIdx (one vote per frame, re-votable)
		currentFrame: 0,
		totalSources: 0,
		totalFrames: 0,
		mask: null, // { x, y, w, h } as fractions of image dimensions (0–1)
		sourceNames: [], // real source names, indexed by real source index
	};

	// ─── UTILITIES ───────────────────────────────────────────────────────────────

	function blindLabel(blindIdx) {
		return LABELS[blindIdx] ?? '?';
	}

	function fisherYatesShuffle(arr) {
		const a = [...arr];
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[a[i], a[j]] = [a[j], a[i]];
		}
		return a;
	}

	function getCurrentRealSourceIndex() {
		const active = document.querySelector('#images-dropdown a.dropdown-item.active');
		if (!active) return 0;
		const match = active.id.match(/dropdown-image-(\d+)/);
		return match ? parseInt(match[1], 10) : 0;
	}

	// Frame index is maintained internally — we do not rely on the URL hash
	// because slow.pics does not update it consistently on frame navigation.

	function getImageElement() {
		return document.querySelector('.image-container #image')
			?? document.querySelector('#image');
	}

	// ─── CSS INJECTION ───────────────────────────────────────────────────────────

	function injectCSS() {
		const style = document.createElement('style');
		style.id = 'abn-styles';
		style.textContent = `
			/* ── Floating panel (draggable) ── */
			#abn-panel {
				position: fixed;
				top: 80px;
				left: 20px;
				z-index: 99999;
				background: #111;
				border: 1px solid #2a2a2a;
				border-radius: 10px;
				padding: 16px;
				min-width: 164px;
				font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
				box-shadow: 0 8px 32px rgba(0,0,0,0.7);
				display: none;
				user-select: none;
				touch-action: none;
			}
			#abn-panel.visible { display: block; }
			#abn-drag-handle {
				cursor: grab;
				padding: 0 0 8px 0;
				margin: -4px -4px 4px -4px;
				text-align: center;
				color: #2a2a2a;
				font-size: 14px;
				letter-spacing: 3px;
				line-height: 1;
				border-radius: 6px 6px 0 0;
				transition: color 0.12s;
			}
			#abn-drag-handle:hover { color: #444; }
			#abn-drag-handle.dragging { cursor: grabbing; color: #555; }

			#abn-source-label {
				font-size: 56px;
				font-weight: 800;
				text-align: center;
				color: #fff;
				line-height: 1;
				letter-spacing: -3px;
				margin-bottom: 2px;
			}
			#abn-source-sublabel {
				font-size: 13px;
				text-align: center;
				color: #444;
				margin-bottom: 10px;
				letter-spacing: 0.12em;
				text-transform: uppercase;
			}
			#abn-frame-info {
				font-size: 13px;
				text-align: center;
				color: #555;
				margin-bottom: 10px;
			}
			/* Fixed-height status line — sits between buttons and secondary controls.
			   Always occupies the same height so the panel never resizes on vote. */
			#abn-vote-status {
				font-size: 12px;
				text-align: center;
				color: #444;
				height: 16px;
				line-height: 16px;
				margin-bottom: 8px;
				overflow: hidden;
				white-space: nowrap;
				text-overflow: ellipsis;
			}
			#abn-vote-status.has-vote   { color: #4caf50; }
			#abn-vote-status.has-skip   { color: #666; }
			#abn-vote-btn {
				width: 100%;
				padding: 8px 6px;
				border: 1px solid transparent;
				border-radius: 6px;
				background: #1e5c1e;
				color: #c8e6c8;
				font-family: inherit;
				font-size: 14px;
				font-weight: 600;
				cursor: pointer;
				margin-bottom: 4px;
				transition: background 0.12s, color 0.12s, border-color 0.12s;
			}
			#abn-vote-btn:hover { background: #2a7a2a; color: #fff; }
			#abn-vote-btn.voted-this {
				background: #0d3d0d;
				color: #4caf50;
				border-color: #2a7a2a;
			}
			#abn-vote-btn.voted-other { background: #1a3a1a; }
			#abn-skip-btn {
				width: 100%;
				padding: 6px;
				border: 1px solid #1f1f1f;
				border-radius: 6px;
				background: transparent;
				color: #444;
				font-family: inherit;
				font-size: 13px;
				cursor: pointer;
				margin-bottom: 8px;
				transition: color 0.12s, border-color 0.12s, background 0.12s;
			}
			#abn-skip-btn:hover { color: #999; border-color: #444; }
			#abn-skip-btn.skipped {
				background: #1a1a1a;
				color: #666;
				border-color: #333;
			}
			.abn-secondary-btn {
				display: block;
				width: 100%;
				padding: 6px;
				border: 1px solid #222;
				border-radius: 5px;
				background: transparent;
				color: #555;
				font-family: inherit;
				font-size: 13px;
				cursor: pointer;
				margin-bottom: 4px;
				transition: color 0.12s, border-color 0.12s;
				text-align: center;
			}
			.abn-secondary-btn:hover { color: #bbb; border-color: #555; }

			/* ── Mask drawing overlay ── */
			#abn-draw-overlay {
				position: fixed;
				z-index: 900;
				cursor: crosshair;
				display: none;
				/* background transparent — only captures mouse events */
			}
			#abn-draw-overlay.active { display: block; }

			#abn-selection-rect {
				position: absolute;
				background: rgba(255, 200, 0, 0.15);
				border: 2px dashed #ffcc00;
				pointer-events: none;
				display: none;
				box-sizing: border-box;
			}

			/* ── Solid black mask overlay (permanent during test) ──
			   z-index 901: above the image, below Bootstrap dropdowns (~1050)
			   pointer-events: none so it never intercepts clicks            */
			#abn-mask-overlay {
				position: fixed;
				z-index: 901;
				background: #000;
				pointer-events: none;
				display: none;
			}
			#abn-mask-overlay.visible { display: block; }

			/* ── Mask setup toolbar ── */
			#abn-mask-toolbar {
				position: fixed;
				z-index: 100000;
				bottom: 80px;
				left: 50%;
				transform: translateX(-50%);
				background: #111;
				border: 1px solid #333;
				border-radius: 8px;
				padding: 10px 18px;
				display: none;
				align-items: center;
				gap: 10px;
				font-family: 'SF Mono', 'Fira Code', monospace;
				font-size: 12px;
				box-shadow: 0 4px 24px rgba(0,0,0,0.7);
				white-space: nowrap;
			}
			#abn-mask-toolbar.visible { display: flex; }
			#abn-mask-toolbar .abn-toolbar-hint { color: #666; }
			#abn-confirm-mask {
				padding: 6px 14px;
				border-radius: 5px;
				border: none;
				background: #1e5c1e;
				color: #c8e6c8;
				font-family: inherit;
				font-size: 12px;
				font-weight: 600;
				cursor: pointer;
			}
			#abn-confirm-mask:disabled {
				background: #1a1a1a;
				color: #444;
				cursor: default;
			}
			#abn-confirm-mask:not(:disabled):hover { background: #2a7a2a; color: #fff; }
			#abn-redraw-mask, #abn-skip-mask {
				padding: 6px 12px;
				border-radius: 5px;
				font-family: inherit;
				font-size: 12px;
				cursor: pointer;
			}
			#abn-redraw-mask { background: #222; border: 1px solid #333; color: #aaa; }
			#abn-redraw-mask:hover { background: #2a2a2a; color: #fff; }
			#abn-skip-mask { background: transparent; border: 1px solid #2a2a2a; color: #555; }
			#abn-skip-mask:hover { color: #999; border-color: #555; }

			/* ── Results modal ── */
			#abn-modal-overlay {
				position: fixed;
				inset: 0;
				z-index: 999999;
				background: rgba(0, 0, 0, 0.88);
				display: none;
				align-items: center;
				justify-content: center;
			}
			#abn-modal-overlay.visible { display: flex; }
			#abn-modal {
				background: #0e0e0e;
				border: 1px solid #2a2a2a;
				border-radius: 12px;
				padding: 28px 32px;
				max-width: 580px;
				width: 92vw;
				max-height: 82vh;
				overflow-y: auto;
				font-family: 'SF Mono', 'Fira Code', monospace;
				color: #ddd;
				position: relative;
			}
			#abn-modal-title {
				margin: 0 0 20px;
				font-size: 17px;
				color: #fff;
				font-weight: 700;
				letter-spacing: -0.5px;
			}
			#abn-close-modal {
				position: absolute;
				top: 18px;
				right: 20px;
				background: none;
				border: none;
				color: #444;
				font-size: 18px;
				cursor: pointer;
				line-height: 1;
				padding: 4px;
				font-family: inherit;
				transition: color 0.12s;
			}
			#abn-close-modal:hover { color: #aaa; }

			.abn-section-label {
				font-size: 10px;
				color: #444;
				text-transform: uppercase;
				letter-spacing: 0.12em;
				margin-bottom: 10px;
			}
			.abn-mapping-row {
				display: flex;
				align-items: center;
				gap: 10px;
				margin-bottom: 8px;
				font-size: 13px;
			}
			.abn-map-letter {
				font-size: 24px;
				font-weight: 800;
				color: #fff;
				width: 28px;
				flex-shrink: 0;
			}
			.abn-map-name {
				color: #888;
				flex: 1;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				font-size: 12px;
			}
			.abn-bar-track {
				width: 80px;
				height: 5px;
				background: #1a1a1a;
				border-radius: 3px;
				overflow: hidden;
				flex-shrink: 0;
			}
			.abn-bar-fill {
				height: 100%;
				background: #2e7d32;
				border-radius: 3px;
			}
			.abn-map-tally {
				color: #555;
				font-size: 12px;
				width: 20px;
				text-align: right;
				flex-shrink: 0;
			}

			.abn-divider {
				border: none;
				border-top: 1px solid #1a1a1a;
				margin: 16px 0;
			}

			.abn-stats {
				font-size: 12px;
				color: #666;
				line-height: 1.8;
			}
			.abn-stats h3 {
				font-size: 12px;
				color: #888;
				margin: 0 0 10px;
				font-weight: 600;
			}
			.abn-sig { color: #66bb6a; }
			.abn-nosig { color: #555; }
			.abn-warn { color: #f59e0b; }

			.abn-frame-tally {
				font-size: 11px;
				color: #333;
				line-height: 2;
				margin-top: 4px;
				letter-spacing: 0.04em;
			}
			.abn-frame-tally span {
				display: inline-block;
				width: 20px;
				text-align: center;
				color: #666;
			}
			.abn-frame-tally span.novote { color: #2a2a2a; }

			#abn-copy-btn {
				margin-top: 18px;
				width: 100%;
				padding: 9px;
				background: #151515;
				border: 1px solid #2a2a2a;
				border-radius: 6px;
				color: #666;
				font-family: inherit;
				font-size: 12px;
				cursor: pointer;
				transition: color 0.12s, border-color 0.12s;
			}
			#abn-copy-btn:hover { color: #bbb; border-color: #555; }
		`;
		document.head.appendChild(style);
	}

	// ─── SHUFFLE MAP ─────────────────────────────────────────────────────────────

	function buildShuffleMap() {
		const indices = Array.from({ length: state.totalSources }, (_, i) => i);
		state.shuffleMap = fisherYatesShuffle(indices);
		state.reverseMap = {};
		state.shuffleMap.forEach((realIdx, blindIdx) => {
			state.reverseMap[realIdx] = blindIdx;
		});
	}

	// ─── SOURCE NAME MASKING ─────────────────────────────────────────────────────
	// The navbar and dropdown are masked to show only blind labels.
	// A MutationObserver re-applies masking whenever the site updates the navbar text
	// (e.g. on source navigation). The shuffleMap is never written to any DOM attribute.

	let navbarObserver = null;

	function applyNavbarMask() {
		if (state.phase !== 'testing') return;
		const realIdx = getCurrentRealSourceIndex();
		const blindIdx = state.reverseMap[realIdx];
		if (blindIdx === undefined) return;
		const masked = `Source ${blindLabel(blindIdx)}`;
		['active-image-name', 'hidden-image-name'].forEach(id => {
			const el = document.getElementById(id);
			if (el && el.textContent !== masked) el.textContent = masked;
		});
	}

	function startNavbarMasking() {
		// Initial mask application only — re-masking on navigation is handled
		// by onNavigationDetected() inside the tracking observer, which avoids
		// having two observers fighting over #active-image-name.
		applyNavbarMask();
	}

	function stopNavbarMasking() {
		if (navbarObserver) { navbarObserver.disconnect(); navbarObserver = null; }
		// Restore original navbar text
		const realIdx = getCurrentRealSourceIndex();
		const name = state.sourceNames[realIdx] ?? '';
		['active-image-name', 'hidden-image-name'].forEach(id => {
			const el = document.getElementById(id);
			if (el && name) el.textContent = name;
		});
	}

	function applyDropdownMask() {
		if (state.phase !== 'testing') return;
		document.querySelectorAll('#images-dropdown a.dropdown-item[id^="dropdown-image-"]')
			.forEach((item, realIdx) => {
				const blindIdx = state.reverseMap[realIdx];
				const textEl = item.querySelector('.source-filter-text') ?? item;
				if (!textEl.dataset.abnOriginal) {
					textEl.dataset.abnOriginal = textEl.textContent.trim();
				}
				textEl.textContent = `Source ${blindLabel(blindIdx)}`;
			});
	}

	function restoreDropdownNames() {
		document.querySelectorAll('#images-dropdown a.dropdown-item[id^="dropdown-image-"]')
			.forEach(item => {
				const textEl = item.querySelector('.source-filter-text') ?? item;
				if (textEl.dataset.abnOriginal !== undefined) {
					textEl.textContent = textEl.dataset.abnOriginal;
					delete textEl.dataset.abnOriginal;
				}
			});
	}

	// ─── FRAME TRACKING ──────────────────────────────────────────────────────────
	// The full URL path changes when navigating frames (e.g. /c/bjazM1oE → /c/A9atFHK2).
	// Source switches within a frame leave the URL unchanged.
	// We intercept history.pushState (used by slow.pics as a SPA) to detect frame changes.
	// Source switches are detected via #active-image-name mutations (same as Script 1).

	let navTrackObserver = null;
	let navMutationBusy = false; // re-entrancy guard: prevents our own DOM writes re-firing
	let lastTrackedUrl = '';
	const urlToFrame = new Map(); // url → frameIndex, supports back-navigation

	function patchHistoryApi() {
		// Wrap pushState/replaceState to emit a custom event — these don't fire
		// popstate natively, which is why hashchange never worked either.
		const wrap = (method) => {
			const original = history[method];
			history[method] = function (...args) {
				original.apply(this, args);
				window.dispatchEvent(new Event('abn-urlchange'));
			};
		};
		wrap('pushState');
		wrap('replaceState');
		window.addEventListener('popstate', () =>
			window.dispatchEvent(new Event('abn-urlchange'))
		);
	}

	function buildUrlFrameMap() {
		// Build a definitive url→frameIndex map from the thumbnail links at the
		// bottom of the page. These are the ground truth — no counting needed.
		urlToFrame.clear();
		const thumbLinks = document.querySelectorAll('#preview a[href]');
		thumbLinks.forEach((a, i) => {
			// href may be relative (/c/XXXXX) or absolute — normalise to full URL
			const url = new URL(a.href, window.location.origin).href;
			urlToFrame.set(url, i);
		});
		state.totalFrames = thumbLinks.length || state.totalFrames;
	}

	function getCurrentFrameFromUrl() {
		const url = window.location.href;
		if (urlToFrame.has(url)) return urlToFrame.get(url);
		// Normalise in case href has trailing slash or query string differences
		const stripped = url.split('?')[0].replace(/\/$/, '');
		for (const [key, idx] of urlToFrame) {
			if (key.split('?')[0].replace(/\/$/, '') === stripped) return idx;
		}
		return state.currentFrame; // unknown URL — keep last value
	}

	function startTracking() {
		buildUrlFrameMap();
		state.currentFrame = getCurrentFrameFromUrl();

		window.addEventListener('abn-urlchange', onUrlChange);

		// Source switches within a frame don't change the URL, so we still
		// need the #active-image-name observer to refresh the panel label and mask.
		const nameEl = document.getElementById('active-image-name');
		if (nameEl) {
			navTrackObserver = new MutationObserver(onSourceMutation);
			navTrackObserver.observe(nameEl, { childList: true, characterData: true, subtree: true });
		}
	}

	function stopTracking() {
		window.removeEventListener('abn-urlchange', onUrlChange);
		if (navTrackObserver) { navTrackObserver.disconnect(); navTrackObserver = null; }
		urlToFrame.clear();
	}

	function onUrlChange() {
		if (state.phase !== 'testing') return;
		const newUrl = window.location.href;
		if (newUrl === lastTrackedUrl) return;
		lastTrackedUrl = newUrl;

		state.currentFrame = getCurrentFrameFromUrl();
		onNavigationDetected();
	}

	function onSourceMutation() {
		// Fires on source switches (URL unchanged). Just refresh UI labels.
		if (state.phase !== 'testing') return;
		if (navMutationBusy) return;
		onNavigationDetected();
	}

	function onNavigationDetected() {
		navMutationBusy = true;
		try {
			applyNavbarMask();
			applyDropdownMask();
			updatePanel();
			updateVoteBtn();
			updateThumbnailBorders();
			if (state.mask) positionMaskOverlay();
		} finally {
			navMutationBusy = false;
		}
	}

	// ─── THUMBNAIL BORDERS ───────────────────────────────────────────────────────
	// Outlines each preview thumbnail: green = voted, orange = current + unvoted,
	// dim = unvisited. Borders are applied via inline style on the <a> wrapper so
	// they're removed cleanly when ABn mode is disabled.

	function updateThumbnailBorders() {
		if (state.phase !== 'testing') {
			clearThumbnailBorders();
			return;
		}
		const thumbLinks = document.querySelectorAll('#preview a[href]');
		thumbLinks.forEach((a, i) => {
			// Apply to the <img> inside the <a> — the <a> is a block element
			// spanning full row width, which would make the outline appear as a
			// wide bar across the page rather than tight around the thumbnail.
			const img = a.querySelector('img') ?? a;
			const v = state.votes[i];
			const voted = typeof v === 'number';
			const nopref = v === 'nopref';
			const current = i === state.currentFrame;
			const color = voted ? '#4caf50'
						: nopref ? '#555'
						: current ? '#f59e0b'
						: 'transparent';
			img.style.outline = `3px solid ${color}`;
			img.style.outlineOffset = '2px';
			img.style.borderRadius = '3px';
			img.style.transition = 'outline-color 0.15s';
			// No display override — preserve the site's original layout
		});
	}

	function clearThumbnailBorders() {
		document.querySelectorAll('#preview a[href] img').forEach(img => {
			img.style.outline = '';
			img.style.outlineOffset = '';
			img.style.borderRadius = '';
			img.style.transition = '';
		});
	}

	// ─── MASK DRAWING ────────────────────────────────────────────────────────────

	let drawOverlay = null;
	let selectionRect = null;
	let maskOverlay = null;
	let maskToolbar = null;
	let isDrawing = false;
	let drawStart = { x: 0, y: 0 };

	function createMaskElements() {
		drawOverlay = document.createElement('div');
		drawOverlay.id = 'abn-draw-overlay';
		selectionRect = document.createElement('div');
		selectionRect.id = 'abn-selection-rect';
		drawOverlay.appendChild(selectionRect);
		document.body.appendChild(drawOverlay);

		maskOverlay = document.createElement('div');
		maskOverlay.id = 'abn-mask-overlay';
		document.body.appendChild(maskOverlay);

		maskToolbar = document.createElement('div');
		maskToolbar.id = 'abn-mask-toolbar';
		maskToolbar.innerHTML = `
			<span class="abn-toolbar-hint">Drag to mark the source label region. Use site controls to verify across all sources.</span>
			<button id="abn-confirm-mask" disabled>✓ Confirm</button>
			<button id="abn-redraw-mask">↺ Redraw</button>
			<button id="abn-skip-mask">No labels — skip</button>
		`;
		document.body.appendChild(maskToolbar);

		document.getElementById('abn-confirm-mask').addEventListener('click', onConfirmMask);
		document.getElementById('abn-redraw-mask').addEventListener('click', onRedrawMask);
		document.getElementById('abn-skip-mask').addEventListener('click', onSkipMask);

		drawOverlay.addEventListener('mousedown', onMouseDown);
		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);
	}

	function destroyMaskElements() {
		document.removeEventListener('mousemove', onMouseMove);
		document.removeEventListener('mouseup', onMouseUp);
		[drawOverlay, maskOverlay, maskToolbar].forEach(el => el?.remove());
		drawOverlay = selectionRect = maskOverlay = maskToolbar = null;
	}

	function positionDrawOverlay() {
		const img = getImageElement();
		if (!img || !drawOverlay) return;
		const r = img.getBoundingClientRect();
		Object.assign(drawOverlay.style, {
			left: r.left + 'px', top: r.top + 'px',
			width: r.width + 'px', height: r.height + 'px',
		});
	}

	// Reposition the mask overlay relative to the current image bounding rect.
	// Uses getBoundingClientRect() which always returns viewport-relative coords
	// regardless of which ancestor scrolled — so this is correct for any scroll target.
	let _maskRafPending = false;
	function positionMaskOverlay() {
		if (!state.mask || !maskOverlay) return;
		if (_maskRafPending) return;
		_maskRafPending = true;
		requestAnimationFrame(() => {
			_maskRafPending = false;
			if (!state.mask || !maskOverlay) return;
			const img = getImageElement();
			if (!img) return;
			const r = img.getBoundingClientRect();
			const m = state.mask;
			Object.assign(maskOverlay.style, {
				left: (r.left + m.x * r.width) + 'px',
				top: (r.top + m.y * r.height) + 'px',
				width: (m.w * r.width) + 'px',
				height: (m.h * r.height) + 'px',
			});
		});
	}

	function enterMaskSetup() {
		positionDrawOverlay();
		drawOverlay.classList.add('active');
		maskToolbar.classList.add('visible');
		window.addEventListener('resize', positionDrawOverlay);
		document.addEventListener('scroll', positionDrawOverlay, { capture: true, passive: true });
	}

	function exitMaskSetup() {
		drawOverlay.classList.remove('active');
		maskToolbar.classList.remove('visible');
		selectionRect.style.display = 'none';
		window.removeEventListener('resize', positionDrawOverlay);
		document.removeEventListener('scroll', positionDrawOverlay, { capture: true });
	}

	function onMouseDown(e) {
		isDrawing = true;
		const r = drawOverlay.getBoundingClientRect();
		drawStart = { x: e.clientX - r.left, y: e.clientY - r.top };
		selectionRect.style.cssText = `display:block; left:${drawStart.x}px; top:${drawStart.y}px; width:0; height:0;`;
		e.preventDefault();
	}

	function onMouseMove(e) {
		if (!isDrawing) return;
		const r = drawOverlay.getBoundingClientRect();
		const cx = e.clientX - r.left;
		const cy = e.clientY - r.top;
		const sx = Math.min(drawStart.x, cx), sy = Math.min(drawStart.y, cy);
		const sw = Math.abs(cx - drawStart.x), sh = Math.abs(cy - drawStart.y);
		Object.assign(selectionRect.style, {
			left: sx + 'px', top: sy + 'px',
			width: sw + 'px', height: sh + 'px',
		});
	}

	function onMouseUp(e) {
		if (!isDrawing) return;
		isDrawing = false;

		const r = drawOverlay.getBoundingClientRect();
		const cx = e.clientX - r.left;
		const cy = e.clientY - r.top;
		const sx = Math.min(drawStart.x, cx), sy = Math.min(drawStart.y, cy);
		const sw = Math.abs(cx - drawStart.x), sh = Math.abs(cy - drawStart.y);

		if (sw < 5 || sh < 5) return; // too small, ignore

		// Store as relative coords so it holds across resizes and different image dimensions
		state.mask = { x: sx / r.width, y: sy / r.height, w: sw / r.width, h: sh / r.height };

		document.getElementById('abn-confirm-mask').disabled = false;
		positionMaskOverlay();
		maskOverlay.classList.add('visible');
	}

	function onConfirmMask() {
		exitMaskSetup();
		beginTest();
	}

	function onRedrawMask() {
		state.mask = null;
		selectionRect.style.display = 'none';
		maskOverlay.classList.remove('visible');
		document.getElementById('abn-confirm-mask').disabled = true;
	}

	function onSkipMask() {
		state.mask = null;
		maskOverlay.classList.remove('visible');
		exitMaskSetup();
		beginTest();
	}

	// ─── TEST SESSION ────────────────────────────────────────────────────────────

	function beginTest() {
		state.phase = 'testing';
		state.votes = {};
		// state.currentFrame is seeded to 0 by startTracking()

		buildShuffleMap(); // shuffle fires here, after mask setup is complete

		// Randomly jump to a source so the user doesn't start on the same one
		// they were viewing during mask setup, which would break the blind.
		const randomRealIdx = Math.floor(Math.random() * state.totalSources);
		const jumpTarget = document.getElementById(`dropdown-image-${randomRealIdx}`);
		if (jumpTarget) jumpTarget.click();

		showPanel();
		applyDropdownMask();
		startNavbarMasking();
		startTracking();

		if (state.mask) {
			maskOverlay.classList.add('visible');
			positionMaskOverlay();
			window.addEventListener('resize', positionMaskOverlay);
			// Use capture-phase listener on document so we receive scroll events
			// from any scrollable ancestor, not just window itself.
			document.addEventListener('scroll', positionMaskOverlay, { capture: true, passive: true });
		}
	}

	function endTest(clearMask = true) {
		state.phase = 'idle';
		stopTracking();
		stopNavbarMasking();
		restoreDropdownNames();
		clearThumbnailBorders();
		hidePanel();

		if (maskOverlay) maskOverlay.classList.remove('visible');
		window.removeEventListener('resize', positionMaskOverlay);
		document.removeEventListener('scroll', positionMaskOverlay, { capture: true });

		if (clearMask) state.mask = null;
	}

	// ─── PANEL UI ────────────────────────────────────────────────────────────────

	let panel = null;

	function createPanel() {
		panel = document.createElement('div');
		panel.id = 'abn-panel';
		panel.innerHTML = `
			<div id="abn-drag-handle" title="Drag to move">⠿⠿⠿</div>
			<div id="abn-source-label">?</div>
			<div id="abn-source-sublabel">blind source</div>
			<div id="abn-frame-info">— / —</div>
			<button id="abn-vote-btn">⭐ Best</button>
			<button id="abn-skip-btn">— No preference</button>
			<div id="abn-vote-status"></div>
			<button class="abn-secondary-btn" id="abn-results-btn">📊 Results</button>
			<button class="abn-secondary-btn" id="abn-reset-btn">↺ New Test</button>
		`;
		document.body.appendChild(panel);
		document.getElementById('abn-vote-btn').addEventListener('click', castVote);
		document.getElementById('abn-skip-btn').addEventListener('click', castSkip);
		document.getElementById('abn-results-btn').addEventListener('click', showResults);
		document.getElementById('abn-reset-btn').addEventListener('click', promptReset);

		// ── Drag to reposition ──
		const handle = document.getElementById('abn-drag-handle');
		let dragging = false, dragOffX = 0, dragOffY = 0;

		handle.addEventListener('mousedown', e => {
			dragging = true;
			handle.classList.add('dragging');
			const r = panel.getBoundingClientRect();
			dragOffX = e.clientX - r.left;
			dragOffY = e.clientY - r.top;
			e.preventDefault();
		});

		document.addEventListener('mousemove', e => {
			if (!dragging) return;
			let x = e.clientX - dragOffX;
			let y = e.clientY - dragOffY;
			// Keep panel within viewport
			x = Math.max(0, Math.min(x, window.innerWidth - panel.offsetWidth));
			y = Math.max(0, Math.min(y, window.innerHeight - panel.offsetHeight));
			panel.style.right = 'auto';
			panel.style.left = x + 'px';
			panel.style.top = y + 'px';
		});

		document.addEventListener('mouseup', () => {
			if (dragging) { dragging = false; handle.classList.remove('dragging'); }
		});
	}

	function showPanel() {
		panel.classList.add('visible');
		updatePanel();
		updateVoteBtn();
	}

	function hidePanel() {
		panel.classList.remove('visible');
	}

	function updatePanel() {
		if (state.phase !== 'testing') return;
		const realIdx = getCurrentRealSourceIndex();
		const blindIdx = state.reverseMap[realIdx];
		document.getElementById('abn-source-label').textContent = blindLabel(blindIdx ?? 0);

		const allVotes = Object.values(state.votes);
		const voteCount = allVotes.filter(v => typeof v === 'number').length;
		const noprefCount = allVotes.filter(v => v === 'nopref').length;
		const skipCount = allVotes.filter(v => v === 'skip').length;
		let suffix = `${voteCount}v`;
		if (noprefCount > 0) suffix += ` ${noprefCount}=`;
		if (skipCount > 0) suffix += ` ${skipCount}·`;
		document.getElementById('abn-frame-info').textContent =
			`Frame ${state.currentFrame + 1} / ${state.totalFrames} · ${suffix}`;
	}

	function updateVoteBtn() {
		if (state.phase !== 'testing') return;
		const voteBtn = document.getElementById('abn-vote-btn');
		const skipBtn = document.getElementById('abn-skip-btn');
		const statusEl = document.getElementById('abn-vote-status');
		const realIdx = getCurrentRealSourceIndex();
		const blindIdx = state.reverseMap[realIdx];
		const frameVote = state.votes[state.currentFrame];
		const isSkipped = frameVote === 'nopref';

		// Vote button — label is always fixed; state shown in status line instead
		voteBtn.className = '';
		voteBtn.textContent = '⭐ Best';
		if (!isSkipped && frameVote !== undefined) {
			voteBtn.classList.add(frameVote === blindIdx ? 'voted-this' : 'voted-other');
		}

		// Skip button — label always fixed
		skipBtn.className = '';
		skipBtn.textContent = '— No preference';
		if (isSkipped) skipBtn.classList.add('skipped');

		// Status line — single fixed-height row summarising this frame's decision
		statusEl.className = 'abn-vote-status'; // reset
		if (isSkipped) {
			statusEl.textContent = '↩ no preference recorded';
			statusEl.classList.add('has-skip');
		} else if (frameVote !== undefined) {
			statusEl.textContent = `✓ voted ${blindLabel(frameVote)} on this frame`;
			statusEl.classList.add('has-vote');
		} else {
			statusEl.textContent = ''; // unvoted — line is empty but still takes space
		}
	}

	// Navigate to the next frame after a vote, wrapping around to frame 0.
	// Clicks the thumbnail link directly so all existing URL-change and
	// MutationObserver tracking fires normally.
	function navigateToNextFrame() {
		const next = (state.currentFrame + 1) % state.totalFrames;
		const thumbLinks = document.querySelectorAll('#preview a[href]');
		const target = thumbLinks[next];
		if (target) target.click();
	}

	function castVote() {
		const realIdx = getCurrentRealSourceIndex();
		const blindIdx = state.reverseMap[realIdx];
		if (blindIdx === undefined) return;
		state.votes[state.currentFrame] = blindIdx;
		updateVoteBtn();
		updatePanel();
		updateThumbnailBorders();
		navigateToNextFrame();
	}

	function castSkip() {
		// "No preference" — sources examined, no winner detectable.
		// Toggle: casting again removes the no-preference record.
		const wasNopref = state.votes[state.currentFrame] === 'nopref';
		if (wasNopref) {
			delete state.votes[state.currentFrame];
		} else {
			state.votes[state.currentFrame] = 'nopref';
		}
		updateVoteBtn();
		updatePanel();
		updateThumbnailBorders();
		// Only advance on a new no-preference vote, not on undo
		if (!wasNopref) navigateToNextFrame();
	}

	function promptReset() {
		const n = Object.keys(state.votes).length;
		if (!confirm(`Reset all ${n} vote${n !== 1 ? 's' : ''} and start a new shuffle?\n\nThe current mask region will be kept.`)) return;
		state.votes = {};
		buildShuffleMap();
		buildUrlFrameMap(); // re-seed from thumbnails
		state.currentFrame = getCurrentFrameFromUrl();
		applyDropdownMask();
		applyNavbarMask();
		updateThumbnailBorders();
		updatePanel();
		updateVoteBtn();
	}

	// ─── STATISTICS — Dirichlet-Multinomial Bayesian model ──────────────────────
	//
	// Model:
	// θ = (θ₀, θ₁, ..., θ_N) ~ Dirichlet(1+M, 1+n₁, ..., 1+n_N)
	// θ₀ = probability of no preference on a voted frame
	// θ_j = probability of preferring source j on a voted frame
	// M = no-preference vote count
	// n_j = preference votes for source j (skips excluded entirely)
	//
	// P(source j is best) computed by Monte Carlo over source components only.
	// 95% CI on P(j best) via normal approximation on Bernoulli indicator.
	// Distinguishability = 1 − E[θ₀], CI via percentiles of MC samples.

	const MC_SAMPLES = 10000;

	// Box-Muller standard normal sample
	function randn() {
		let u, v;
		do { u = Math.random(); } while (u === 0);
		v = Math.random();
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	}

	// Marsaglia-Tsang Gamma(alpha, 1) sampler
	function sampleGamma(alpha) {
		if (alpha < 1) {
			return sampleGamma(alpha + 1) * Math.pow(Math.random(), 1 / alpha);
		}
		const d = alpha - 1 / 3;
		const c = 1 / Math.sqrt(9 * d);
		for (;;) {
			let x, v;
			do { x = randn(); v = 1 + c * x; } while (v <= 0);
			v = v * v * v;
			const u = Math.random();
			if (u < 1 - 0.0331 * x * x * x * x) return d * v;
			if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
		}
	}

	// Sample one draw from Dirichlet(alphas)
	function sampleDirichlet(alphas) {
		const gammas = alphas.map(a => sampleGamma(a));
		const sum = gammas.reduce((s, g) => s + g, 0);
		return gammas.map(g => g / sum);
	}

	function computeStats() {
		const N = state.totalSources;
		const allVoteEntries = Object.entries(state.votes);
		const prefEntries = allVoteEntries.filter(([, v]) => v !== 'skip' && v !== undefined);
		const noPrefs = prefEntries.filter(([, v]) => v === 'nopref').length;

		// Preference votes per blind source index (numeric)
		const n = Array(N).fill(0);
		prefEntries.forEach(([, v]) => { if (typeof v === 'number') n[v]++; });
		const K = n.reduce((s, x) => s + x, 0); // total preference votes
		const M = noPrefs; // total no-preference votes

		// Posterior concentration parameters: α = (1+M, 1+n_0, ..., 1+n_{N-1})
		// Index 0 in alpha array = θ₀ (no-preference), indices 1..N = sources
		const alpha = [1 + M, ...n.map(ni => 1 + ni)];
		const alphaSum = alpha.reduce((s, a) => s + a, 0);

		// Posterior means
		const eMeanTie = alpha[0] / alphaSum;
		const eMeanSources = alpha.slice(1).map(a => a / alphaSum);

		const totalVoted = K + M;
		const notVoted = state.totalFrames - totalVoted;

		// ── Monte Carlo ──────────────────────────────────────────────────────────
		// Each draw samples θ = (θ₀, θ₁, ..., θ_N) from the posterior Dirichlet.
		// We then compute φ_j = θ_j / (1−θ₀) — the win-rate of source j conditional
		// on the frame being discriminable. argmax φ_j = argmax θ_j (order preserved
		// under positive scaling) so P(best) win-counts are identical either way.
		//
		// phiSamples[j]: stores φ_j across all draws.
		// - Sample mean → E[φ_j]: posterior expected conditional win-rate.
		// - 2.5/97.5 percentiles → 95% prediction interval on φ_j.
		// Interpretation: "If I drew a new random discriminable frame, source j
		// would win between lo% and hi% of the time, with 95% credibility."
		//
		// distSamples: stores (1−θ₀) across all draws.
		// - Sample mean → E[1−θ₀]: posterior expected distinguishability.
		// - 2.5/97.5 percentiles → 95% prediction interval on distinguishability.
		//
		// All intervals use the same MC percentile method and reflect genuine
		// posterior uncertainty from the data. Note: Σ_j φ_j = 1 by construction,
		// so source prediction intervals are not independent — a shift in one
		// implies compensating shifts in others.

		const winCounts = Array(N).fill(0);
		const distSamples = new Float64Array(MC_SAMPLES);
		// phiSamples[j] stores φ_j = θ_j / (1−θ₀) draws; sorted in-place after loop
		const phiSamples = Array.from({length: N}, () => new Float64Array(MC_SAMPLES));

		for (let s = 0; s < MC_SAMPLES; s++) {
			const draw = sampleDirichlet(alpha);
			// draw[0] = θ₀, draw[1..N] = θ_j
			const disc = 1 - draw[0]; // = 1 − θ₀ (always > 0 since Gamma samples > 0)
			distSamples[s] = disc;

			// Normalise source components to get conditional win-rates φ_j
			let bestJ = 0, bestPhi = draw[1] / disc;
			phiSamples[0][s] = bestPhi;
			for (let j = 1; j < N; j++) {
				const phi = draw[j + 1] / disc;
				phiSamples[j][s] = phi;
				if (phi > bestPhi) { bestPhi = phi; bestJ = j; }
			}
			winCounts[bestJ]++;
		}

		// P(j best): fraction of draws where source j had the highest φ_j
		const pBest = winCounts.map(w => w / MC_SAMPLES);

		// E[φ_j] and 95% prediction interval from MC percentiles
		phiSamples.forEach(s => s.sort((a, b) => a - b));
		const phiMean = phiSamples.map(s => s.reduce((a, b) => a + b, 0) / MC_SAMPLES);
		const ciLo = phiSamples.map(s => s[Math.floor(0.025 * MC_SAMPLES)]);
		const ciHi = phiSamples.map(s => s[Math.floor(0.975 * MC_SAMPLES)]);

		// Distinguishability: E[1−θ₀] and 95% prediction interval
		distSamples.sort((a, b) => a - b);
		const distMean = distSamples.reduce((a, b) => a + b, 0) / MC_SAMPLES;
		const distCiLo = distSamples[Math.floor(0.025 * MC_SAMPLES)];
		const distCiHi = distSamples[Math.floor(0.975 * MC_SAMPLES)];

		return {
			N, K, M, notVoted, totalVoted,
			n, // raw preference vote counts per blind source index
			alpha, // posterior Dirichlet parameters (for reference)
			pBest, // P(source j is best) — scalar per source
			phiMean, // E[φ_j] — posterior expected conditional win-rate
			ciLo, ciHi, // 95% prediction interval on φ_j
			distMean, distCiLo, distCiHi,
		};
	}

	// ── ASCII bar chart renderer (for copyable output) ────────────────────────
	// BAR_WIDTH = 40 chars → each char = 2.5%
	// Major ticks (|) at 0, 25, 50, 75, 100% → char positions 0,10,20,30,40
	// Minor ticks (:) at every 10% → char positions 4,8,12,16,24,28,32,36
	// Note: 25% and 10% intervals are geometrically compatible (LCM = 20)
	// but do NOT share a repeating segment pattern — ruler is built programmatically.
	const BAR_WIDTH = 40;
	const toBarPos = p => Math.min(BAR_WIDTH - 1, Math.max(0, Math.round(p * BAR_WIDTH)));

	// Build ruler programmatically so minor tick positions are exact
	// Build ruler programmatically — minor ticks at every 10%, major at 25% intervals.
	// 25% (pos 10) and 10% (pos 4) are geometrically compatible (LCM=20) with
	// BAR_WIDTH=40, but the pattern is NOT repeating — must be built position by position.
	const _rulerArr = Array(BAR_WIDTH + 1).fill(' ');
	[10,20,30,40,60,70,80,90].forEach(pct => { _rulerArr[Math.round(pct/100*BAR_WIDTH)] = ':'; });
	[0,25,50,75,100].forEach(pct => { _rulerArr[Math.round(pct/100*BAR_WIDTH)] = '|'; });
	const AXIS_RULER = () => _rulerArr.join('');
	// Labels: each label left-aligned to its tick position (verified: | at 0,10,20,30,40)
	// 0% (2ch) at pos 0 → 8sp → 25% (3ch) at pos 10 → 7sp → 50% → 7sp → 75% → 7sp → 100%
	const AXIS_LABELS = () => '0%' + ' '.repeat(8) + '25%' + ' '.repeat(7) +
						 '50%' + ' '.repeat(7) + '75%' + ' '.repeat(7) + '100%';

	function renderBar(pBest, ciLo, ciHi) {
		const loPos = toBarPos(ciLo);
		const ptPos = toBarPos(pBest);
		const hiPos = toBarPos(ciHi);

		// Suppress CI brackets when either side is < 2% of range
		// (interval too narrow to render meaningfully — just show point estimate)
		const showCI = (pBest - ciLo >= 0.02) && (ciHi - pBest >= 0.02);

		let bar = Array(BAR_WIDTH).fill(' ');
		if (showCI) {
			for (let i = loPos; i <= hiPos; i++) bar[i] = '═';
			bar[loPos] = '[';
			bar[hiPos] = ']';
		}
		bar[ptPos] = '▌'; // point estimate always takes priority
		return bar.join('');
	}

	// ─── RESULTS MODAL ───────────────────────────────────────────────────────────

	let modalOverlay = null;

	function createModal() {
		modalOverlay = document.createElement('div');
		modalOverlay.id = 'abn-modal-overlay';
		modalOverlay.innerHTML = `
			<div id="abn-modal">
				<button id="abn-close-modal">✕</button>
				<div id="abn-modal-title">ABn Test Results</div>
				<div id="abn-modal-body"></div>
				<button id="abn-copy-btn">📋 Copy plain-text results</button>
			</div>
		`;
		document.body.appendChild(modalOverlay);
		document.getElementById('abn-close-modal').addEventListener('click', () => modalOverlay.classList.remove('visible'));
		document.getElementById('abn-copy-btn').addEventListener('click', copyResults);
		modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) modalOverlay.classList.remove('visible'); });
	}

	function showResults() {
		const stats = computeStats();
		const body = document.getElementById('abn-modal-body');

		// ── Header ───────────────────────────────────────────────────────────────
		const notVotedModal = state.totalFrames - ((stats.K ?? 0) + (stats.M ?? 0));
		let html = `<div class="abn-section-label">
			${state.totalFrames} frames total &nbsp;|&nbsp;
			${stats.K ?? 0} preference &nbsp;|&nbsp;
			${stats.M ?? 0} no-preference &nbsp;|&nbsp;
			${notVotedModal} not voted
		</div>`;

		// ── Distinguishability ───────────────────────────────────────────────────
		const dPct = (stats.distMean * 100).toFixed(0);
		const dLoPct = (stats.distCiLo * 100).toFixed(0);
		const dHiPct = (stats.distCiHi * 100).toFixed(0);
		const distLabel = stats.distMean > 0.6 ? 'sources clearly distinguishable in most frames'
						: stats.distMean > 0.2 ? 'sources differ noticeably in some frames'
						: 'sources largely indistinguishable — rankings below should be interpreted cautiously';
		const distColor = stats.distMean > 0.6 ? '#4caf50' : stats.distMean > 0.2 ? '#f59e0b' : '#e57373';

		html += `<div style="margin:14px 0 16px; padding:10px 12px; background:#0a0a0a; border-radius:6px; border-left: 3px solid ${distColor};">
			<div style="font-size:11px; color:#444; text-transform:uppercase; letter-spacing:0.1em; margin-bottom:4px;">Distinguishability</div>
			<div style="font-size:22px; font-weight:700; color:${distColor}; line-height:1;">${dPct}%</div>
			<div style="font-size:11px; color:#555; margin-top:2px;">95% prediction interval [${dLoPct}%–${dHiPct}%] &nbsp;·&nbsp; ${distLabel}</div>
		</div>`;

		// ── Per-source bars ───────────────────────────────────────────────────────
		// Bar shows E[φ_j] (conditional win-rate) with prediction interval.
		// P(best) reported as a separate scalar — a different quantity on the same scale.
		// Sorted by P(best) descending.
		const order = state.shuffleMap
			.map((realIdx, blindIdx) => ({ realIdx, blindIdx }))
			.sort((a, b) => stats.pBest[b.blindIdx] - stats.pBest[a.blindIdx]);

		html += `<div style="font-size:10px; color:#333; margin-bottom:10px;">
			Bar: conditional win-rate E[φⱼ] with 95% prediction interval &nbsp;·&nbsp;
			P(best) = posterior probability this source has the highest win-rate
		</div>`;
		html += `<div style="margin-bottom:6px;">`;
		order.forEach(({ realIdx, blindIdx }) => {
			const name = state.sourceNames[realIdx] ?? `Source ${realIdx}`;
			const phi = stats.phiMean[blindIdx];
			const lo = stats.ciLo[blindIdx];
			const hi = stats.ciHi[blindIdx];
			const pb = stats.pBest[blindIdx];
			const votes = stats.n[blindIdx];
			const phiPct = (phi * 100).toFixed(0);
			const loPct = (lo * 100).toFixed(0);
			const hiPct = (hi * 100).toFixed(0);
			const pbPct = (pb * 100).toFixed(0);

			// Bar tracks φ_j (0–100% scale), prediction interval as shaded region
			const loW = (lo * 100).toFixed(2);
			const phiW = (phi * 100).toFixed(2);
			const ciW = ((hi - lo) * 100).toFixed(2);

			// Suppress PI display when either side < 2%
			const showPI = (phi - lo >= 0.02) && (hi - phi >= 0.02);
			const ciLabel = showPI ? `[${loPct}%–${hiPct}%]` : ``;

			html += `
			<div style="margin-bottom:14px;">
			  <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:3px;">
				<span style="color:#ccc;">${name}</span>
				<span style="color:#555;">${votes} vote${votes!==1?'s':''}</span>
			  </div>
			  <div style="position:relative; height:10px; background:#0a0a0a; border-radius:3px; margin-bottom:3px;">
				${showPI ? `<div style="position:absolute; left:${loW}%; width:${ciW}%; height:100%; background:#1e4d1e; border-radius:2px;"></div>` : ''}
				<div style="position:absolute; left:calc(${phiW}% - 1px); width:2px; height:100%; background:#4caf50; border-radius:1px;"></div>
			  </div>
			  <div style="display:flex; justify-content:space-between; font-size:11px; color:#555;">
				<span>0%</span>
				<span style="color:#888;">E[φ] = ${phiPct}% ${ciLabel} &nbsp;·&nbsp; <span style="color:#6ab06a;">P(best) = ${pbPct}%</span></span>
				<span>100%</span>
			  </div>
			</div>`;
		});
		html += `</div>`;

		// ── Per-frame breakdown ───────────────────────────────────────────────────
		html += `<hr class="abn-divider">
		<div class="abn-section-label">Per-frame votes</div>
		<div class="abn-frame-tally">`;
		for (let i = 0; i < state.totalFrames; i++) {
			const v = state.votes[i];
			let display, cls;
			if (v === undefined) { display = '—'; cls = 'novote'; }
			else if (v === 'skip') { display = '·'; cls = 'novote'; }
			else if (v === 'nopref') { display = '='; cls = ''; }
			else { display = blindLabel(v); cls = ''; }
			html += `<span class="${cls}" title="Frame ${i+1}: ${display}">${display}</span>`;
		}
		html += `</div>
		<div style="font-size:10px; color:#333; margin-top:6px;">
			A–Z: preference vote &nbsp; =: no preference &nbsp; ·: not voted
		</div>`;

		body.innerHTML = html;
		modalOverlay.classList.add('visible');
	}

	function copyResults() {
		const stats = computeStats();

		// ── Helpers ───────────────────────────────────────────────────────────────
		const pct = (v, dp=0) => (v * 100).toFixed(dp) + '%';

		// Name padding for aligned bar chart
		const names = state.shuffleMap.map((ri) =>
			state.sourceNames[ri] ?? `Source ${ri}`);
		const padLen = Math.max(...names.map(n => n.length));
		const pad = s => s.padEnd(padLen);

		// Axis ruler/labels are defined as module-level constants (AXIS_RULER, AXIS_LABELS)

		// ── Build text ────────────────────────────────────────────────────────────
		let t = '';
		t += '=== ABn Blind Test Results ===\n';
		t += window.location.href + '\n\n';

		t += `${state.totalFrames} frames total | ${stats.K} preference | ${stats.M} no-preference | ${stats.notVoted} not voted\n\n`;

		{
			// Distinguishability
			const dPct = pct(stats.distMean);
			const dLoPct = pct(stats.distCiLo);
			const dHiPct = pct(stats.distCiHi);
			const distLabel = stats.distMean > 0.6 ? 'Sources clearly distinguishable in most frames'
							: stats.distMean > 0.2 ? 'Sources differ noticeably in some frames'
							: 'Sources largely indistinguishable — rankings below should be interpreted cautiously';
			t += `Distinguishability: ${dPct} [95% prediction interval: ${dLoPct}–${dHiPct}]\n`;
			t += `${distLabel}\n\n`;

			// Bar chart — sorted by P(best) descending
			// Bar position = E[φ_j], interval = 95% prediction interval on φ_j
			// P(best) reported as a separate scalar on each row
			const order = state.shuffleMap
				.map((ri, bi) => ({ ri, bi }))
				.sort((a, b) => stats.pBest[b.bi] - stats.pBest[a.bi]);

			t += ' '.repeat(padLen + 1) + AXIS_LABELS() + '\n';
			t += ' '.repeat(padLen + 1) + AXIS_RULER() + '\n';
			order.forEach(({ ri, bi }) => {
				const name = state.sourceNames[ri] ?? `Source ${ri}`;
				const phi = stats.phiMean[bi];
				const lo = stats.ciLo[bi];
				const hi = stats.ciHi[bi];
				const pb = stats.pBest[bi];
				const bar = renderBar(phi, lo, hi);
				const votes = stats.n[bi];
				// Suppress PI numerically when either side < 2%
				const showPI = (phi - lo >= 0.02) && (hi - phi >= 0.02);
				const piStr = showPI
					? `[${pct(lo)}–${pct(hi)}]`.padEnd(14)
					: ' '.repeat(14);
				t += `${pad(name)} ${bar} E[φ]=${pct(phi).padStart(4)} ${piStr} P(best)=${pct(pb).padStart(4)} ${votes}v\n`;
			});
			t += ' '.repeat(padLen + 1) + AXIS_RULER() + '\n';
			t += ' '.repeat(padLen + 1) + AXIS_LABELS() + '\n\n';
			t += ' ▌ = E[φⱼ]: expected win-rate on a discriminable frame\n';
			t += ' [═══] = 95% prediction interval on φⱼ\n';
			t += ' P(best): posterior probability this source has the highest φⱼ of all sources\n\n';

						// Per-frame legend in original source order, blind label in parens
			const legendParts = state.sourceNames.map((name, ri) => {
				const bi = state.reverseMap[ri];
				return `${name} (${blindLabel(bi)})`;
			});
			t += 'Per-frame (' + legendParts.join(' | ') + ')\n ';
			for (let i = 0; i < state.totalFrames; i++) {
				if (i > 0 && i % 10 === 0) t += '| ';
				const v = state.votes[i];
				if (v === undefined) t += '— ';
				else if (v === 'skip') t += '— ';
				else if (v === 'nopref') t += '= ';
				else t += blindLabel(v) + ' ';
			}
			t += '\n (=: no preference —: not voted |: every 10 frames)\n\n';

			t += `Model: Dirichlet-Multinomial, uniform prior.\n`;
			t += `All intervals are 95% posterior prediction intervals via ${MC_SAMPLES.toLocaleString()} Monte Carlo samples.\n`;
		}

		const btn = document.getElementById('abn-copy-btn');
		const write = typeof GM !== 'undefined' && GM.setClipboard
			? s => GM.setClipboard(s)
			: s => navigator.clipboard.writeText(s).catch(() => {});
		write(t);
		btn.textContent = '✓ Copied!';
		setTimeout(() => { btn.textContent = '📋 Copy plain-text results'; }, 2500);
	}


	// ─── SOURCE SELECTION PROMPT ───────────────────────────────────────────────────

	function showSourceSelectionPrompt(names, callback) {
		const overlay = document.createElement('div');
		overlay.id = 'abn-source-select-overlay';
		overlay.style.cssText = 'position:fixed;inset:0;z-index:200000;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;';

		const box = document.createElement('div');
		box.style.cssText = "background:#0e0e0e;border:1px solid #2a2a2a;border-radius:12px;padding:28px 32px;max-width:480px;width:90vw;font-family:'SF Mono','Fira Code',monospace;color:#ddd;";

		const title = document.createElement('div');
		title.textContent = 'Select sources to test';
		title.style.cssText = 'font-size:17px;font-weight:700;color:#fff;margin-bottom:18px;letter-spacing:-0.5px;';
		box.appendChild(title);

		const sub = document.createElement('div');
		sub.textContent = 'Deselect sources to exclude. At least 2 required.';
		sub.style.cssText = 'font-size:11px;color:#444;margin-bottom:16px;';
		box.appendChild(sub);

		const checkboxes = names.map((name, i) => {
			const row = document.createElement('label');
			row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;cursor:pointer;margin-bottom:4px;font-size:13px;color:#ccc;transition:background 0.1s;';
			row.addEventListener('mouseenter', () => { row.style.background = '#1a1a1a'; });
			row.addEventListener('mouseleave', () => { row.style.background = ''; });

			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.checked = true;
			cb.style.cssText = 'width:14px;height:14px;accent-color:#4caf50;cursor:pointer;flex-shrink:0;';

			const lbl = document.createElement('span');
			lbl.textContent = name || `Source ${i + 1}`;

			row.appendChild(cb);
			row.appendChild(lbl);
			box.appendChild(row);
			return cb;
		});

		const btnRow = document.createElement('div');
		btnRow.style.cssText = 'display:flex;gap:10px;margin-top:22px;justify-content:flex-end;';

		const cancelBtn = document.createElement('button');
		cancelBtn.textContent = 'Cancel';
		cancelBtn.style.cssText = 'padding:8px 18px;border-radius:6px;border:1px solid #333;background:transparent;color:#555;font-family:inherit;font-size:13px;cursor:pointer;';
		cancelBtn.addEventListener('click', () => { overlay.remove(); callback(null); });

		const startBtn = document.createElement('button');
		startBtn.textContent = '\u{1F500} Start ABn Test';
		startBtn.style.cssText = 'padding:8px 18px;border-radius:6px;border:none;background:#1e5c1e;color:#c8e6c8;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;';
		startBtn.addEventListener('click', () => {
			const selected = checkboxes.map((c, i) => c.checked ? i : -1).filter(i => i !== -1);
			if (selected.length < 2) {
				sub.textContent = '\u26a0 Select at least 2 sources.';
				sub.style.color = '#e57373';
				return;
			}
			overlay.remove();
			callback(selected);
		});

		btnRow.appendChild(cancelBtn);
		btnRow.appendChild(startBtn);
		box.appendChild(btnRow);
		overlay.appendChild(box);
		document.body.appendChild(overlay);
	}

	// ─── ENABLE / DISABLE ABN ────────────────────────────────────────────────────

	let abnBtn = null;

	function enableAbn() {
		state.active = true;
		abnBtn.textContent = '🔀 ABn: ON';
		abnBtn.classList.replace('btn-secondary', 'btn-success');

		// Collect source metadata before shuffle so it's available for results later
		const items = document.querySelectorAll('#images-dropdown a.dropdown-item[id^="dropdown-image-"]');
		state.totalSources = items.length;
		state.sourceNames = Array.from(items).map(item => {
			const t = item.querySelector('.source-filter-text') ?? item;
			const raw = t.dataset.originalText ?? t.textContent.trim();
			return raw
				.replace(/^\d+\/\d+\s*:?\s*/, '') // remove leading "1/4 " or "1/4: " ordinal prefix
				.replace(/\s*\([IBP]\)/g, '') // remove (I), (B), (P) tokens
				.replace(/\s*\[\d+(?:\.\d+)?\s*\w+\]$/, '') // remove trailing [1.8 MiB] etc.
				.trim();
		});

		// Frame count from the preview panel
		const previewLinks = document.querySelectorAll('#preview a');
		state.totalFrames = Math.max(previewLinks.length, 1);

		// Prompt user to select which sources to include before starting.
		const allNames = [...state.sourceNames];
		showSourceSelectionPrompt(allNames, selectedIndices => {
			if (!selectedIndices || selectedIndices.length < 2) {
				state.active = false;
				abnBtn.textContent = '🔀 ABn Mode';
				abnBtn.classList.replace('btn-success', 'btn-secondary');
				return;
			}
			state.totalSources = selectedIndices.length;
			state.sourceNames = selectedIndices.map(i => allNames[i]);
			state._sourceItemIds = selectedIndices.map(i => items[i]?.id ?? `dropdown-image-${i}`);
			createMaskElements();
			enterMaskSetup();
		});
	}

	function disableAbn() {
		if (state.phase === 'testing') endTest();
		else exitMaskSetup();
		destroyMaskElements();

		state.active = false;
		state.phase = 'idle';
		state.votes = {};
		state.mask = null;
		state.shuffleMap = [];
		state.reverseMap = {};

		abnBtn.textContent = '🔀 ABn Mode';
		abnBtn.classList.replace('btn-success', 'btn-secondary');
	}

	function onAbnToggle() {
		if (state.active) {
			const n = Object.keys(state.votes).length;
			const msg = n > 0
				? `Exit ABn mode? All ${n} vote${n !== 1 ? 's' : ''} will be lost.`
				: 'Exit ABn mode?';
			if (!confirm(msg)) return;
			disableAbn();
		} else {
			enableAbn();
		}
	}

	// ─── INIT ────────────────────────────────────────────────────────────────────

	function setup() {
		const ready = setInterval(() => {
			const dropdown = document.getElementById('images-dropdown');
			// Navbar: slow.pics uses a <nav> with a .navbar-nav for its top controls
			const navbar = document.querySelector('.navbar-nav, nav .d-flex, .navbar .ms-auto, .navbar');
			if (!dropdown || !navbar) return;
			clearInterval(ready);

			injectCSS();
			createPanel();
			createModal();

			abnBtn = document.createElement('button');
			abnBtn.textContent = '🔀 ABn';
			abnBtn.className = 'btn btn-secondary btn-sm ms-2';
			abnBtn.type = 'button';
			abnBtn.style.cssText = 'font-size: 12px; padding: 4px 10px; white-space: nowrap;';
			abnBtn.addEventListener('click', onAbnToggle);

			// Try to insert alongside other navbar controls; fall back to appending
			const navbarRight = document.querySelector('.navbar .d-flex, .navbar-nav');
			if (navbarRight) {
				navbarRight.appendChild(abnBtn);
			} else {
				navbar.appendChild(abnBtn);
			}
		}, 500);
	}

	patchHistoryApi(); // must run before any navigation occurs

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', setup);
	} else {
		setup();
	}
})();
