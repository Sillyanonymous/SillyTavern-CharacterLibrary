

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

export function init() {
    if (isInitialized) return;
    
    injectStyles();
    injectModal();
    setupEventListeners();
    
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
    currentImages = [];
    currentIndex = 0;
    currentCharacter = null;
    currentZoom = 1;
    panX = 0;
    panY = 0;
    isDragging = false;
    didDrag = false;
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

function showImage(index) {
    if (index < 0 || index >= currentImages.length) return;
    
    currentIndex = index;
    const media = currentImages[index];
    
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
            imgEl.src = media.url;
            imgEl.alt = media.name;
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
}

function resetZoom() {
    currentZoom = 1;
    panX = 0;
    panY = 0;
    const imgEl = document.getElementById('galleryViewerImage');
    if (imgEl) {
        imgEl.style.transform = `scale(1)`;
        imgEl.style.cursor = '';
    }
    updateZoomIndicator();
}

// Zoom indicator timeout
let zoomIndicatorTimeout = null;

function applyZoom(delta) {
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
    
    strip.innerHTML = currentImages.map((media, idx) => {
        const mediaIsVideo = isVideo(media);
        if (mediaIsVideo) {
            // Video thumbnail with small play icon
            return `
                <div class="gv-thumb ${idx === currentIndex ? 'active' : ''}" data-index="${idx}">
                    <video src="${media.url}" preload="metadata" muted></video>
                    <div class="gv-thumb-video-icon"><i class="fa-solid fa-play"></i></div>
                </div>
            `;
        } else {
            // Image thumbnail
            return `
                <div class="gv-thumb ${idx === currentIndex ? 'active' : ''}" data-index="${idx}">
                    <img src="${media.url}" alt="${media.name}" loading="lazy">
                </div>
            `;
        }
    }).join('');
}

function updateThumbnailSelection() {
    const strip = document.getElementById('galleryViewerThumbnails');
    if (!strip) return;
    
    strip.querySelectorAll('.gv-thumb').forEach((thumb, idx) => {
        thumb.classList.toggle('active', idx === currentIndex);
    });
    
    // Scroll active thumbnail into view
    const activeThumb = strip.querySelector('.gv-thumb.active');
    if (activeThumb) {
        activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
}

function prevImage() {
    if (currentImages.length === 0) return;
    const newIndex = currentIndex > 0 ? currentIndex - 1 : currentImages.length - 1;
    showImage(newIndex);
}

function nextImage() {
    if (currentImages.length === 0) return;
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
        if (!isNaN(idx)) showImage(idx);
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
        const clickedOnImage = e.target.id === 'galleryViewerImage';
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
            case 'Escape':
                closeViewer();
                e.preventDefault();
                break;
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

function injectStyles() {
    if (document.getElementById('gallery-viewer-styles')) return;
    
    const styles = `
    <style id="gallery-viewer-styles">
        /* Gallery Viewer Modal */
        .gv-modal {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.95);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10001;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.2s, visibility 0.2s;
        }
        
        .gv-modal.visible {
            opacity: 1;
            visibility: visible;
        }
        
        .gv-container {
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
        }
        
        /* Header */
        .gv-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 20px;
            background: rgba(0, 0, 0, 0.5);
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .gv-header-left {
            display: flex;
            align-items: center;
            gap: 10px;
            color: #fff;
            font-size: 0.95em;
        }
        
        .gv-header-left i {
            color: var(--SmartThemeQuoteColor, #4a9eff);
        }
        
        .gv-separator {
            opacity: 0.5;
        }
        
        .gv-header-right {
            display: flex;
            gap: 8px;
        }
        
        .gv-btn {
            background: rgba(255, 255, 255, 0.1);
            border: none;
            color: #fff;
            width: 36px;
            height: 36px;
            border-radius: 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
        }
        
        .gv-btn:hover {
            background: rgba(255, 255, 255, 0.2);
        }
        
        .gv-close-btn:hover {
            background: rgba(239, 68, 68, 0.5);
        }
        
        /* Body */
        .gv-body {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            overflow: hidden;
        }
        
        /* Loading state */
        .gv-loader {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 12px;
            color: rgba(255, 255, 255, 0.7);
        }
        
        .gv-loader i {
            font-size: 2em;
            color: var(--SmartThemeQuoteColor, #4a9eff);
        }
        
        /* Empty state */
        .gv-empty {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 12px;
            color: rgba(255, 255, 255, 0.5);
        }
        
        .gv-empty i {
            font-size: 3em;
            opacity: 0.5;
        }
        
        .gv-empty.hidden,
        .gv-loader.hidden,
        .gv-content.hidden {
            display: none;
        }
        
        /* Image content */
        .gv-content {
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer; /* Indicates clickable to close */
            position: relative;
            overflow: hidden; /* Contain zoomed image */
        }
        
        .gv-image-container {
            flex: 1;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            cursor: pointer; /* Click outside image to close */
        }
        
        .gv-image {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            border-radius: 8px;
            box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5);
            transition: transform 0.1s ease-out;
            cursor: pointer; /* Click left/right halves to navigate */
        }
        
        /* Video player styles */
        .gv-video {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            border-radius: 8px;
            box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5);
            outline: none;
        }
        
        .gv-video::-webkit-media-controls-panel {
            background: linear-gradient(transparent, rgba(0, 0, 0, 0.7));
        }
        
        /* Zoom hint cursor */
        .gv-content {
            cursor: zoom-in;
        }
        
        /* Navigation */
        .gv-nav {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            background: rgba(0, 0, 0, 0.5);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #fff;
            width: 50px;
            height: 80px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
            z-index: 10;
        }
        
        .gv-nav:hover:not(:disabled) {
            background: rgba(255, 255, 255, 0.1);
        }
        
        .gv-nav:disabled {
            opacity: 0.3;
            cursor: not-allowed;
        }
        
        .gv-nav i {
            font-size: 1.5em;
        }
        
        .gv-nav-prev {
            left: 0;
            border-radius: 0 8px 8px 0;
        }
        
        .gv-nav-next {
            right: 0;
            border-radius: 8px 0 0 8px;
        }
        
        /* Footer */
        .gv-footer {
            padding: 10px 20px;
            background: rgba(0, 0, 0, 0.5);
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            text-align: center;
        }
        
        .gv-filename {
            color: rgba(255, 255, 255, 0.6);
            font-size: 0.85em;
            font-family: monospace;
        }
        
        /* Thumbnail strip */
        .gv-thumbnails {
            display: flex;
            gap: 8px;
            padding: 12px 20px;
            background: rgba(0, 0, 0, 0.7);
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            overflow-x: auto;
            scrollbar-width: thin;
            scrollbar-color: rgba(255, 255, 255, 0.3) transparent;
            scroll-behavior: smooth;
        }
        
        .gv-thumbnails::-webkit-scrollbar {
            height: 6px;
        }
        
        .gv-thumbnails::-webkit-scrollbar-track {
            background: transparent;
        }
        
        .gv-thumbnails::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.3);
            border-radius: 3px;
        }
        
        .gv-thumb {
            flex-shrink: 0;
            width: 60px;
            height: 60px;
            border-radius: 6px;
            overflow: hidden;
            cursor: pointer;
            border: 2px solid transparent;
            opacity: 0.6;
            transition: all 0.2s;
        }
        
        .gv-thumb:hover {
            opacity: 0.9;
            border-color: rgba(255, 255, 255, 0.3);
        }
        
        .gv-thumb.active {
            opacity: 1;
            border-color: var(--SmartThemeQuoteColor, #4a9eff);
            box-shadow: 0 0 10px rgba(74, 158, 255, 0.4);
        }
        
        .gv-thumb img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
        
        .gv-thumb video {
            width: 100%;
            height: 100%;
            object-fit: cover;
            pointer-events: none;
        }
        
        /* Video thumbnail play icon */
        .gv-thumb-video-icon {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.5);
            border-radius: 50%;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .gv-thumb-video-icon i {
            font-size: 0.6rem;
            color: #fff;
            margin-left: 2px;
        }
        
        .gv-thumb {
            position: relative;
        }
        
        /* Zoom indicator */
        .gv-zoom-indicator {
            position: absolute;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.7);
            color: #fff;
            padding: 4px 12px;
            border-radius: 4px;
            font-size: 0.85em;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.2s;
        }
        
        .gv-zoom-indicator.visible {
            opacity: 1;
        }
    </style>`;
    
    document.head.insertAdjacentHTML('beforeend', styles);
}

// Export for module registration
export default {
    init,
    openViewer,
    openViewerWithImages,
    closeViewer
};
