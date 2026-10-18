const SECTION_OFFSET = 32;
// Native anchor scrolling can round fractional heading coordinates to a CSS pixel.
const SCROLL_ROUNDING_TOLERANCE = 1;

/** Native anchors and dialog keyboard behavior remain owned by the browser. */
function initializeHelp(doc = document, win = window) {
    const toc = doc.getElementById('help-toc');
    const content = doc.getElementById('help-content');
    if (!toc || !content) return;

    const chapters = Array.from(toc.querySelectorAll('a[href]'), link => ({
        link,
        heading: doc.getElementById(link.getAttribute('href').slice(1)),
        parent: link.closest('li')?.parentElement?.closest('li')?.querySelector('a[href]') || link
    })).filter(chapter => chapter.heading);
    const groups = chapters.filter(chapter => chapter.link === chapter.parent)
        .map(chapter => ({ link: chapter.link, list: chapter.link.closest('li').querySelector('ol') }))
        .filter(group => group.list);
    for (const group of groups) group.link.setAttribute('aria-controls', group.list.id);
    let current = null;
    const markCurrent = chapter => {
        if (!chapter || chapter === current) return;
        current?.link.removeAttribute('aria-current');
        current?.parent.classList.remove('is-current-chapter');
        chapter.link.setAttribute('aria-current', 'location');
        chapter.parent.classList.add('is-current-chapter');
        for (const group of groups) {
            group.list.hidden = group.link !== chapter.parent;
            group.link.setAttribute('aria-expanded', String(!group.list.hidden));
        }
        current = chapter;
        if (toc.scrollHeight > toc.clientHeight) {
            const bounds = toc.getBoundingClientRect();
            const item = chapter.link.getBoundingClientRect();
            if (item.top < bounds.top) toc.scrollTop += item.top - bounds.top;
            else if (item.bottom > bounds.bottom) toc.scrollTop += item.bottom - bounds.bottom;
        }
    };
    const updateChapter = () => {
        let chapter = chapters[0];
        for (const candidate of chapters) {
            if (candidate.heading.getBoundingClientRect().top > SECTION_OFFSET + SCROLL_ROUNDING_TOLERANCE) break;
            chapter = candidate;
        }
        const scrollRoot = doc.scrollingElement || doc.documentElement;
        const height = scrollRoot.scrollHeight;
        if (height > win.innerHeight && scrollRoot.scrollTop + win.innerHeight >= height - 2) {
            chapter = chapters[chapters.length - 1];
        }
        markCurrent(chapter);
    };
    let pending = false;
    const scheduleUpdate = () => {
        if (pending) return;
        pending = true;
        win.requestAnimationFrame(() => {
            pending = false;
            updateChapter();
        });
    };
    const updateHash = () => {
        markCurrent(chapters.find(chapter => `#${chapter.heading.id}` === win.location.hash));
        scheduleUpdate();
    };
    const narrow = win.matchMedia('(max-width: 900px)');
    const updateToc = () => { toc.open = !narrow.matches; };
    updateToc();
    narrow.addEventListener('change', updateToc);
    win.addEventListener('scroll', scheduleUpdate, { passive: true });
    doc.addEventListener('scroll', scheduleUpdate, { capture: true, passive: true });
    win.addEventListener('resize', scheduleUpdate);
    win.addEventListener('pageshow', scheduleUpdate);
    win.addEventListener('hashchange', updateHash);
    content.addEventListener('load', scheduleUpdate, true);
    updateChapter();
    updateHash();
    const tabClose = doc.getElementById('help-tab-close');
    const tabCloseNotice = doc.getElementById('help-tab-close-notice');
    if (tabClose) {
        tabClose.addEventListener('click', () => {
            try {
                win.close();
            } catch (_) {}
            if (tabCloseNotice) {
                tabCloseNotice.hidden = false;
            }
        });
    }

    const dialog = doc.getElementById('help-image-dialog');
    const close = doc.getElementById('help-image-close');
    const preview = doc.getElementById('help-image-preview');
    const title = doc.getElementById('help-image-title');
    const caption = doc.getElementById('help-image-caption');
    const imageScroll = dialog?.querySelector('.help-image-scroll');
    if (!dialog || !close || !preview || !title || !caption || typeof dialog.showModal !== 'function') return;

    let origin = null;
    content.addEventListener('click', event => {
        const link = event.target.closest('a[data-help-image]');
        if (!link || !content.contains(link) || event.defaultPrevented || event.button > 0
            || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        const image = link.querySelector('img');
        origin = link;
        preview.src = link.getAttribute('href');
        preview.alt = image.getAttribute('alt');
        title.textContent = link.dataset.caption;
        caption.textContent = link.closest('figure')?.querySelector('figcaption')?.textContent || image.getAttribute('alt');
        dialog.showModal();
        dialog.scrollTop = 0;
        dialog.scrollLeft = 0;
        if (imageScroll) {
            imageScroll.scrollTop = 0;
            imageScroll.scrollLeft = 0;
        }
        close.focus({ preventScroll: true });
        event.preventDefault();
    });
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right
            || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    // Escape uses the dialog's native cancel action; every closing route resets here.
    dialog.addEventListener('close', () => {
        preview.removeAttribute('src');
        preview.alt = '';
        title.textContent = '';
        caption.textContent = '';
        const returnTo = origin;
        origin = null;
        if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    });
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initializeHelp(), { once: true });
    } else {
        initializeHelp();
    }
}
