

import * as CoreAPI from './core-api.js';

const debugLog = (...args) => {
    if (CoreAPI.getSetting?.('debugMode')) {
        console.log(...args);
    }
};

// Module state
let isInitialized = false;
let currentImages = [];
let currentIndex = 0;
let currentCharacter = null;
let currentZoom = 1;
let panX = 0;
let panY = 0;
let currentMediaIsGif = false;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartPanX = 0;
let dragStartPanY = 0;
let didDrag = false;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.25;
const DRAG_DEAD_ZONE = 5;
const VIRTUAL_SCROLL_THRESHOLD = 200;
const VIRTUAL_BUFFER = 20;
const GIF_FREEZE_BATCH = 5;

// Virtual scroll state
let _virtualScrollActive = false;
let _renderedThumbs = new Map();
let _thumbStride = 72;
let _thumbOuterH = 64;
let _scrollRafPending = false;
let _lastNavDirection = 1;
const _gifFreezeQueue = [];
let _gifFreezeRafId = null;

export function init() {
    if (isInitialized) return;
    
    injectModal();
    setupEventListeners();

    window.registerOverlay?.({
        id: 'galleryViewerModal',
        tier: 2,
        close: () => closeViewer(),
        visible: (el) => el.classList.contains('visible'),
    });
    
    isInitialized = true;
    debugLog('[GalleryViewer] Module initialized');
}

export async function openViewer(char, startIndex = 0) {
    if (!char) {
        CoreAPI.showToast('No character provided', 'error');
        return;
    }
    
    currentCharacter = char;
    currentImages = [];
    currentIndex = 0;
    
    // Show loading state
    const modal = document.getElementById('galleryViewerModal');
    const loader = document.getElementById('galleryViewerLoader');
    const content = document.getElementById('galleryViewerContent');
    const emptyState = document.getElementById('galleryViewerEmpty');
    
    modal?.classList.add('visible');
    loader?.classList.remove('hidden');
    content?.classList.add('hidden');
    emptyState?.classList.add('hidden');
    
    // Update character info
    updateCharacterInfo(char);
    
    // Fetch gallery images
    try {
        const images = await fetchGalleryImages(char);
        currentImages = images;
        
        loader?.classList.add('hidden');
        
        if (images.length === 0) {
            emptyState?.classList.remove('hidden');
            return;
        }
        
        content?.classList.remove('hidden');
        renderThumbnails();
        updateCounter();
        
        // Use provided start index (clamped to valid range)
        const validIndex = Math.max(0, Math.min(startIndex, images.length - 1));
        showImage(validIndex);
        
    } catch (err) {
        console.error('[GalleryViewer] Failed to load gallery:', err);
        loader?.classList.add('hidden');
        emptyState?.classList.remove('hidden');
        document.getElementById('galleryViewerEmptyText').textContent = 'Failed to load gallery images';
    }
}

export function openViewerWithImages(images, startIndex = 0, title = 'Gallery') {
    if (!images || images.length === 0) {
        CoreAPI.showToast('No images to display', 'error');
        return;
    }
    
    currentCharacter = null;
    currentImages = images;
    currentIndex = 0;
    
    const modal = document.getElementById('galleryViewerModal');
    const loader = document.getElementById('galleryViewerLoader');
    const content = document.getElementById('galleryViewerContent');
    const emptyState = document.getElementById('galleryViewerEmpty');
    
    modal?.classList.add('visible');
    loader?.classList.add('hidden');
    content?.classList.remove('hidden');
    emptyState?.classList.add('hidden');
    
    // Update title
    const nameEl = document.getElementById('galleryViewerCharName');
    if (nameEl) {
        nameEl.textContent = title;
    }
    
    renderThumbnails();
    updateCounter();
    
    // Use provided start index (clamped to valid range)
    const validIndex = Math.max(0, Math.min(startIndex, images.length - 1));
    showImage(validIndex);
}

export function closeViewer() {
    const modal = document.getElementById('galleryViewerModal');
    const videoEl = document.getElementById('galleryViewerVideo');
    
    // Pause any playing video
    if (videoEl) {
        videoEl.pause();
        videoEl.src = '';
    }
    
    // Clear any pending zoom indicator timeout
    if (typeof zoomIndicatorTimeout !== 'undefined' && zoomIndicatorTimeout) {
        clearTimeout(zoomIndicatorTimeout);
    }
    
    modal?.classList.remove('visible');
    _preloadedUrls.clear();
    _gvThumbObserver?.disconnect();

    // Virtual scroll cleanup
    const strip = document.getElementById('galleryViewerThumbnails');
    if (strip?._gvScrollHandler) {
        strip.removeEventListener('scroll', strip._gvScrollHandler);
        delete strip._gvScrollHandler;
    }
    strip?.classList.remove('gv-virtual');
    _virtualScrollActive = false;
    _renderedThumbs.clear();
    _scrollRafPending = false;

    // GIF freeze queue cleanup
    _gifFreezeQueue.length = 0;
    if (_gifFreezeRafId) {
        cancelAnimationFrame(_gifFreezeRafId);
        _gifFreezeRafId = null;
    }

    currentImages = [];
    currentIndex = 0;
    currentCharacter = null;
    currentZoom = 1;
    panX = 0;
    panY = 0;
    currentMediaIsGif = false;
    isDragging = false;
    didDrag = false;
    _lastNavDirection = 1;
}

async function fetchGalleryImages(char) {
    const folderName = CoreAPI.getGalleryFolderName(char);
    
    debugLog('[GalleryViewer] Fetching images for folder:', folderName);
    
    const response = await CoreAPI.apiRequest('/images/list', 'POST', {
        folder: folderName,
        type: 7
    });
    
    if (!response.ok) {
        throw new Error('Failed to fetch gallery images');
    }
    
    const files = await response.json();
    debugLog('[GalleryViewer] Files received:', files);
    
    // Filter to image and video files and build URLs
    const mediaFiles = (files || []).filter(f => 
        f.match(/\.(png|jpg|jpeg|webp|gif|bmp|mp4|webm|mov|avi|mkv|m4v)$/i)
    );
    
    const safeFolderName = CoreAPI.sanitizeFolderName(folderName);
    
    return mediaFiles.map(fileName => {
        const isVideoFile = fileName.match(/\.(mp4|webm|mov|avi|mkv|m4v)$/i);
        return {
            name: fileName,
            url: `/user/images/${encodeURIComponent(safeFolderName)}/${encodeURIComponent(fileName)}`,
            type: isVideoFile ? 'video' : 'image'
        };
    });
}

function updateCharacterInfo(char) {
    const nameEl = document.getElementById('galleryViewerCharName');
    if (nameEl) {
        nameEl.textContent = char.name || 'Character';
    }
}

function updateCounter() {
    const counterEl = document.getElementById('galleryViewerCounter');
    if (counterEl) {
        counterEl.textContent = `${currentIndex + 1} / ${currentImages.length}`;
    }
}

function isVideo(media) {
    if (media.type === 'video') return true;
    return media.name?.match(/\.(mp4|webm|mov|avi|mkv|m4v)$/i);
}

function isGif(media) {
    if (!media) return false;
    return media.name?.match(/\.gif$/i);
}

function freezeGifThumbnail(imgEl, maxSize = 160) {
    if (!imgEl || imgEl.dataset.gifThumbFrozen === '1' || imgEl.dataset.gifThumbPending === '1') return;
    imgEl.dataset.gifThumbPending = '1';

    const finalize = () => {
        delete imgEl.dataset.gifThumbPending;
    };

    const renderPoster = () => {
        if (!imgEl.isConnected || imgEl.dataset.gifThumbFrozen === '1') {
            finalize();
            return;
        }

        const src = imgEl.currentSrc || imgEl.src;
        const w = imgEl.naturalWidth;
        const h = imgEl.naturalHeight;
        if (!src || src.startsWith('data:') || !w || !h) {
            finalize();
            return;
        }

        try {
            const scale = Math.min(1, maxSize / Math.max(w, h));
            const tw = Math.max(1, Math.round(w * scale));
            const th = Math.max(1, Math.round(h * scale));
            const canvas = document.createElement('canvas');
            canvas.width = tw;
            canvas.height = th;

            const ctx = canvas.getContext('2d', { alpha: true });
            if (!ctx) {
                canvas.width = 0;
                canvas.height = 0;
                finalize();
                return;
            }

            ctx.drawImage(imgEl, 0, 0, tw, th);
            const dataUrl = canvas.toDataURL('image/webp', 0.82);
            canvas.width = 0;
            canvas.height = 0;

            imgEl.src = dataUrl;
            imgEl.dataset.gifThumbFrozen = '1';
        } catch (err) {
            // Ignore conversion failures and keep the original GIF thumbnail.
        } finally {
            finalize();
        }
    };

    if (imgEl.complete && imgEl.naturalWidth > 0) {
        renderPoster();
    } else {
        imgEl.addEventListener('load', renderPoster, { once: true });
        imgEl.addEventListener('error', finalize, { once: true });
    }
}

function showImage(index) {
    if (index < 0 || index >= currentImages.length) return;
    
    currentIndex = index;
    const media = currentImages[index];
    currentMediaIsGif = isGif(media);
    
    const imgEl = document.getElementById('galleryViewerImage');
    const videoEl = document.getElementById('galleryViewerVideo');
    const filenameEl = document.getElementById('galleryViewerFilename');
    
    // Determine if this is a video
    const mediaIsVideo = isVideo(media);
    
    if (mediaIsVideo) {
        // Show video, hide image
        if (imgEl) imgEl.style.display = 'none';
        if (videoEl) {
            videoEl.style.display = 'block';
            videoEl.src = media.url;
            videoEl.muted = true; // Always start muted
            videoEl.load();
            // Auto-play after loading
            videoEl.onloadeddata = () => {
                videoEl.play().catch(() => {}); // Ignore autoplay errors
            };
        }
    } else {
        // Show image, hide video
        if (videoEl) {
            videoEl.pause();
            videoEl.style.display = 'none';
        }
        if (imgEl) {
            imgEl.style.display = 'block';
            imgEl.classList.toggle('is-gif', currentMediaIsGif);
            imgEl.src = media.url;
            imgEl.alt = media.name;
            imgEl.decode().catch(() => {});
            // Reset zoom when changing images
            resetZoom();
        }
    }
    
    if (filenameEl) {
        filenameEl.textContent = media.name;
    }
    
    updateCounter();
    updateNavButtons();
    updateThumbnailSelection();
    preloadAdjacent(index);
}

function resetZoom() {
    currentZoom = 1;
    panX = 0;
    panY = 0;
    const imgEl = document.getElementById('galleryViewerImage');
    if (imgEl) {
        imgEl.style.transform = currentMediaIsGif ? 'none' : 'scale(1)';
        imgEl.style.cursor = '';
    }
    updateZoomIndicator();
}

const _preloadedUrls = new Set();

function preloadAdjacent(index) {
    const offsets = _lastNavDirection > 0
        ? [1, 2, 3, -1]
        : [-1, -2, -3, 1];
    for (const off of offsets) {
        const i = (index + off + currentImages.length) % currentImages.length;
        if (i === index) continue;
        const m = currentImages[i];
        if (!m || isVideo(m) || _preloadedUrls.has(m.url)) continue;
        _preloadedUrls.add(m.url);
        const img = new Image();
        img.decoding = 'async';
        img.src = m.url;
    }
}

// Zoom indicator timeout
let zoomIndicatorTimeout = null;

function applyZoom(delta) {
    if (currentMediaIsGif) return;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentZoom + delta));
    if (newZoom !== currentZoom) {
        currentZoom = newZoom;
        // Reset pan when zooming back to 1x
        if (currentZoom <= 1) {
            panX = 0;
            panY = 0;
        } else {
            // Clamp pan to new zoom bounds
            clampPan();
        }
        applyTransform();
        showZoomIndicator();
    }
}

function applyTransform() {
    if (currentMediaIsGif) return;
    const imgEl = document.getElementById('galleryViewerImage');
    if (!imgEl) return;
    if (panX === 0 && panY === 0) {
        imgEl.style.transform = `scale(${currentZoom})`;
    } else {
        imgEl.style.transform = `scale(${currentZoom}) translate(${panX}px, ${panY}px)`;
    }
    imgEl.style.cursor = currentZoom > 1 ? 'grab' : '';
}

function clampPan() {
    const container = document.querySelector('.gv-image-container');
    const imgEl = document.getElementById('galleryViewerImage');
    if (!container || !imgEl) return;
    const cRect = container.getBoundingClientRect();
    const maxPanX = Math.max(0, (cRect.width * 0.5) / currentZoom);
    const maxPanY = Math.max(0, (cRect.height * 0.5) / currentZoom);
    panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
    panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
}

function showZoomIndicator() {
    const indicator = document.getElementById('galleryViewerZoomIndicator');
    if (!indicator) return;
    
    indicator.textContent = `${Math.round(currentZoom * 100)}%`;
    indicator.classList.add('visible');
    
    // Clear existing timeout
    if (zoomIndicatorTimeout) {
        clearTimeout(zoomIndicatorTimeout);
    }
    
    // Hide after delay
    zoomIndicatorTimeout = setTimeout(() => {
        indicator.classList.remove('visible');
    }, 1000);
}

function updateZoomIndicator() {
    const indicator = document.getElementById('galleryViewerZoomIndicator');
    if (indicator) {
        indicator.textContent = `${Math.round(currentZoom * 100)}%`;
    }
}

function updateNavButtons() {
    // Navigation buttons are always enabled with round robin
    const prevBtn = document.getElementById('galleryViewerPrev');
    const nextBtn = document.getElementById('galleryViewerNext');
    
    if (prevBtn) {
        prevBtn.disabled = currentImages.length <= 1;
    }
    if (nextBtn) {
        nextBtn.disabled = currentImages.length <= 1;
    }
}

function renderThumbnails() {
    const strip = document.getElementById('galleryViewerThumbnails');
    if (!strip) return;

    _renderedThumbs.clear();
    _gifFreezeQueue.length = 0;

    if (currentImages.length <= VIRTUAL_SCROLL_THRESHOLD) {
        _virtualScrollActive = false;
        strip.classList.remove('gv-virtual');
        renderAllThumbnailsDirect(strip);
        return;
    }

    // Virtual scroll mode - measure in flex mode before switching
    const metrics = measureThumbStride(strip);
    _thumbStride = metrics.stride;
    _thumbOuterH = metrics.thumbOuterH;

    _virtualScrollActive = true;
    strip.classList.add('gv-virtual');

    const totalWidth = currentImages.length * _thumbStride - (_thumbStride - (metrics.thumbOuterW || _thumbOuterH));
    strip.innerHTML = '';

    const spacer = document.createElement('div');
    spacer.className = 'gv-thumb-spacer';
    spacer.style.width = totalWidth + 'px';
    spacer.style.height = _thumbOuterH + 'px';
    strip.appendChild(spacer);

    renderVisibleThumbs(strip);

    if (strip._gvScrollHandler) {
        strip.removeEventListener('scroll', strip._gvScrollHandler);
    }
    strip._gvScrollHandler = () => {
        if (_scrollRafPending) return;
        _scrollRafPending = true;
        requestAnimationFrame(() => {
            _scrollRafPending = false;
            renderVisibleThumbs(strip);
        });
    };
    strip.addEventListener('scroll', strip._gvScrollHandler, { passive: true });
}

function measureThumbStride(strip) {
    const placeholder = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 1 1\'/%3E';
    strip.innerHTML = `<div class="gv-thumb" data-index="0"><img src="${placeholder}"></div><div class="gv-thumb" data-index="1"><img src="${placeholder}"></div>`;
    const thumbs = strip.querySelectorAll('.gv-thumb');
    if (thumbs.length >= 2) {
        const r0 = thumbs[0].getBoundingClientRect();
        const r1 = thumbs[1].getBoundingClientRect();
        const stride = Math.round(r1.left - r0.left);
        const thumbOuterW = Math.round(r0.width);
        const thumbOuterH = Math.round(r0.height);
        strip.innerHTML = '';
        return { stride, thumbOuterW, thumbOuterH };
    }
    strip.innerHTML = '';
    return { stride: 72, thumbOuterW: 64, thumbOuterH: 64 };
}

function renderAllThumbnailsDirect(strip) {
    const esc = CoreAPI.escapeHtml;
    strip.innerHTML = currentImages.map((media, idx) => {
        const mediaIsVideo = isVideo(media);
        const mediaIsGif = isGif(media);
        if (mediaIsVideo) {
            return `
                <div class="gv-thumb ${idx === currentIndex ? 'active' : ''}" data-index="${idx}">
                    <video src="${esc(media.url)}" preload="metadata" muted></video>
                    <div class="gv-thumb-video-icon"><i class="fa-solid fa-play"></i></div>
                </div>
            `;
        } else if (mediaIsGif) {
            return `
                <div class="gv-thumb ${idx === currentIndex ? 'active' : ''} gif-thumb" data-index="${idx}">
                    <img src="${esc(media.url)}" alt="${esc(media.name)}" decoding="async" data-gif="1">
                </div>
            `;
        } else {
            return `
                <div class="gv-thumb ${idx === currentIndex ? 'active' : ''}" data-index="${idx}">
                    <img data-src="${esc(media.url)}" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/%3E" alt="${esc(media.name)}" decoding="async" data-gif="0">
                </div>
            `;
        }
    }).join('');

    strip.querySelectorAll('img[data-gif="1"]').forEach((img) => freezeGifThumbnail(img));
    observeGvThumbnails(strip);
}

function createThumbElement(media, idx) {
    const div = document.createElement('div');
    div.className = `gv-thumb${idx === currentIndex ? ' active' : ''}${isGif(media) ? ' gif-thumb' : ''}`;
    div.dataset.index = idx;

    if (isVideo(media)) {
        const video = document.createElement('video');
        video.src = media.url;
        video.preload = 'metadata';
        video.muted = true;
        div.appendChild(video);
        const iconDiv = document.createElement('div');
        iconDiv.className = 'gv-thumb-video-icon';
        iconDiv.innerHTML = '<i class="fa-solid fa-play"></i>';
        div.appendChild(iconDiv);
    } else {
        const img = document.createElement('img');
        img.src = media.url;
        img.alt = media.name;
        img.decoding = 'async';
        if (isGif(media)) {
            img.dataset.gif = '1';
            queueGifFreeze(img);
        } else {
            img.dataset.gif = '0';
        }
        div.appendChild(img);
    }

    return div;
}

function renderVisibleThumbs(strip) {
    if (!_virtualScrollActive || !strip) return;

    const scrollLeft = strip.scrollLeft;
    const viewWidth = strip.clientWidth;

    const firstVisible = Math.floor(scrollLeft / _thumbStride);
    const lastVisible = Math.ceil((scrollLeft + viewWidth) / _thumbStride);
    const startIdx = Math.max(0, firstVisible - VIRTUAL_BUFFER);
    const endIdx = Math.min(currentImages.length - 1, lastVisible + VIRTUAL_BUFFER);

    for (const [idx, el] of _renderedThumbs) {
        if (idx < startIdx || idx > endIdx) {
            el.remove();
            _renderedThumbs.delete(idx);
        }
    }

    const fragment = document.createDocumentFragment();
    for (let idx = startIdx; idx <= endIdx; idx++) {
        if (_renderedThumbs.has(idx)) continue;
        const media = currentImages[idx];
        const div = createThumbElement(media, idx);
        div.style.position = 'absolute';
        div.style.left = (idx * _thumbStride) + 'px';
        div.style.top = '0';
        fragment.appendChild(div);
        _renderedThumbs.set(idx, div);
    }

    if (fragment.childNodes.length > 0) {
        strip.appendChild(fragment);
    }
}

function queueGifFreeze(imgEl) {
    _gifFreezeQueue.push(imgEl);
    if (!_gifFreezeRafId) {
        _gifFreezeRafId = requestAnimationFrame(processGifFreezeQueue);
    }
}

function processGifFreezeQueue() {
    const batch = _gifFreezeQueue.splice(0, GIF_FREEZE_BATCH);
    for (const img of batch) {
        freezeGifThumbnail(img);
    }
    if (_gifFreezeQueue.length > 0) {
        _gifFreezeRafId = requestAnimationFrame(processGifFreezeQueue);
    } else {
        _gifFreezeRafId = null;
    }
}

let _gvThumbObserver = null;

function observeGvThumbnails(strip) {
    if (!_gvThumbObserver) {
        _gvThumbObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const img = entry.target;
                if (img.dataset.src) {
                    img.src = img.dataset.src;
                    delete img.dataset.src;
                    img.decode().catch(() => {});
                }
                _gvThumbObserver.unobserve(img);
            }
        }, { root: strip, rootMargin: '200px' });
    } else {
        _gvThumbObserver.disconnect();
    }
    strip.querySelectorAll('img[data-src]').forEach(img => _gvThumbObserver.observe(img));
}

function updateThumbnailSelection() {
    const strip = document.getElementById('galleryViewerThumbnails');
    if (!strip) return;

    if (_virtualScrollActive) {
        for (const [idx, el] of _renderedThumbs) {
            el.classList.toggle('active', idx === currentIndex);
        }
        const targetLeft = currentIndex * _thumbStride - (strip.clientWidth / 2) + (_thumbStride / 2);
        strip.scrollTo({ left: Math.max(0, targetLeft), behavior: 'smooth' });
    } else {
        strip.querySelectorAll('.gv-thumb').forEach((thumb) => {
            const idx = parseInt(thumb.dataset.index, 10);
            thumb.classList.toggle('active', idx === currentIndex);
        });
        const activeThumb = strip.querySelector('.gv-thumb.active');
        if (activeThumb) {
            activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    }
}

function prevImage() {
    if (currentImages.length === 0) return;
    _lastNavDirection = -1;
    const newIndex = currentIndex > 0 ? currentIndex - 1 : currentImages.length - 1;
    showImage(newIndex);
}

function nextImage() {
    if (currentImages.length === 0) return;
    _lastNavDirection = 1;
    const newIndex = currentIndex < currentImages.length - 1 ? currentIndex + 1 : 0;
    showImage(newIndex);
}

function openInNewTab() {
    if (currentImages[currentIndex]) {
        window.open(currentImages[currentIndex].url, '_blank');
    }
}

function setupEventListeners() {
    // Close button
    document.getElementById('galleryViewerClose')?.addEventListener('click', closeViewer);
    
    // Navigation buttons
    document.getElementById('galleryViewerPrev')?.addEventListener('click', prevImage);
    document.getElementById('galleryViewerNext')?.addEventListener('click', nextImage);
    
    // Thumbnail strip - single delegated handler
    document.getElementById('galleryViewerThumbnails')?.addEventListener('click', (e) => {
        const thumb = e.target.closest('.gv-thumb');
        if (!thumb) return;
        const idx = parseInt(thumb.dataset.index, 10);
        if (!isNaN(idx)) {
            _lastNavDirection = idx >= currentIndex ? 1 : -1;
            showImage(idx);
        }
    });
    
    // Open in new tab
    document.getElementById('galleryViewerOpenBtn')?.addEventListener('click', openInNewTab);
    
    // Close on backdrop click (modal background)
    document.getElementById('galleryViewerModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'galleryViewerModal') {
            closeViewer();
        }
    });
    
    // Close when clicking the image container area (but not the image itself)
    document.getElementById('galleryViewerContent')?.addEventListener('click', (e) => {
        // Don't close if we just finished a drag
        if (didDrag) return;
        // Close if clicking on the content area but not on the image, nav buttons, or their children
        const clickedOnImage = e.target.id === 'galleryViewerImage' || e.target.id === 'galleryViewerVideo';
        const clickedOnNav = e.target.closest('.gv-nav');
        if (!clickedOnImage && !clickedOnNav) {
            closeViewer();
        }
    });
    
    // Click on image: if zoomed, reset zoom; otherwise navigate prev/next halves
    document.getElementById('galleryViewerImage')?.addEventListener('click', (e) => {
        // If we just finished a drag, suppress this click
        if (didDrag) {
            didDrag = false;
            e.stopPropagation();
            return;
        }
        // If zoomed in, click anywhere on image resets zoom
        if (currentZoom > 1) {
            resetZoom();
            showZoomIndicator();
            e.stopPropagation();
            return;
        }
        const img = e.target;
        const rect = img.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const halfWidth = rect.width / 2;
        
        if (clickX < halfWidth) {
            prevImage();
        } else {
            nextImage();
        }
    });
    
    // Desktop drag-to-pan when zoomed
    const imageContainer = document.querySelector('.gv-image-container');
    if (imageContainer) {
        imageContainer.addEventListener('mousedown', (e) => {
            if (currentZoom <= 1 || e.button !== 0) return;
            isDragging = true;
            didDrag = false;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            dragStartPanX = panX;
            dragStartPanY = panY;
            const imgEl = document.getElementById('galleryViewerImage');
            if (imgEl) {
                imgEl.style.cursor = 'grabbing';
                imgEl.style.transition = 'none';
            }
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            if (!didDrag && (Math.abs(dx) > DRAG_DEAD_ZONE || Math.abs(dy) > DRAG_DEAD_ZONE)) {
                didDrag = true;
            }
            panX = dragStartPanX + dx / currentZoom;
            panY = dragStartPanY + dy / currentZoom;
            clampPan();
            applyTransform();
        });

        window.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            const imgEl = document.getElementById('galleryViewerImage');
            if (imgEl) {
                imgEl.style.cursor = currentZoom > 1 ? 'grab' : '';
                imgEl.style.transition = '';
            }
        });
    }

    // Scroll wheel zoom on image container
    document.getElementById('galleryViewerContent')?.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
        applyZoom(delta);
    }, { passive: false });
    
    // Horizontal scroll for thumbnails (scroll wheel scrolls horizontally)
    document.getElementById('galleryViewerThumbnails')?.addEventListener('wheel', (e) => {
        const thumbnails = document.getElementById('galleryViewerThumbnails');
        if (thumbnails) {
            e.preventDefault();
            thumbnails.scrollLeft += e.deltaY;
        }
    }, { passive: false });
    
    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('galleryViewerModal');
        if (!modal?.classList.contains('visible')) return;
        
        switch (e.key) {
            case 'ArrowLeft':
                prevImage();
                e.preventDefault();
                break;
            case 'ArrowRight':
                nextImage();
                e.preventDefault();
                break;
            case '0':
                // Reset zoom with 0 key
                resetZoom();
                e.preventDefault();
                break;
        }
    });
}

function injectModal() {
    if (document.getElementById('galleryViewerModal')) return;
    
    const modalHtml = `
    <div id="galleryViewerModal" class="gv-modal">
        <div class="gv-container">
            <!-- Header -->
            <div class="gv-header">
                <div class="gv-header-left">
                    <i class="fa-solid fa-images"></i>
                    <span id="galleryViewerCharName">Character</span>
                    <span class="gv-separator">•</span>
                    <span id="galleryViewerCounter">0 / 0</span>
                </div>
                <div class="gv-header-right">
                    <button id="galleryViewerOpenBtn" class="gv-btn" title="Open in new tab">
                        <i class="fa-solid fa-external-link-alt"></i>
                    </button>
                    <button id="galleryViewerClose" class="gv-btn gv-close-btn" title="Close (Esc)">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            
            <!-- Main content area -->
            <div class="gv-body">
                <!-- Loading state -->
                <div id="galleryViewerLoader" class="gv-loader">
                    <i class="fa-solid fa-spinner fa-spin"></i>
                    <span>Loading gallery...</span>
                </div>
                
                <!-- Empty state -->
                <div id="galleryViewerEmpty" class="gv-empty hidden">
                    <i class="fa-solid fa-image"></i>
                    <span id="galleryViewerEmptyText">No gallery images found</span>
                </div>
                
                <!-- Image viewer -->
                <div id="galleryViewerContent" class="gv-content hidden">
                    <button id="galleryViewerPrev" class="gv-nav gv-nav-prev" title="Previous (←)">
                        <i class="fa-solid fa-chevron-left"></i>
                    </button>
                    
                    <div class="gv-image-container">
                        <img id="galleryViewerImage" src="" alt="" class="gv-image">
                        <video id="galleryViewerVideo" class="gv-video" controls muted loop style="display: none;"></video>
                        <div id="galleryViewerZoomIndicator" class="gv-zoom-indicator">100%</div>
                    </div>
                    
                    <button id="galleryViewerNext" class="gv-nav gv-nav-next" title="Next (→)">
                        <i class="fa-solid fa-chevron-right"></i>
                    </button>
                </div>
            </div>
            
            <!-- Thumbnail strip -->
            <div id="galleryViewerThumbnails" class="gv-thumbnails"></div>
            
            <!-- Footer with filename -->
            <div class="gv-footer">
                <span id="galleryViewerFilename" class="gv-filename"></span>
            </div>
        </div>
    </div>`;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

// Export for module registration
export default {
    init,
    openViewer,
    openViewerWithImages,
    closeViewer
};
