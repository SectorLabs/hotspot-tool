// --- Application State ---
let currentWorkflow = '';
let hotspotStyle = { borderColor: '0xFFFFFF', fillColor: '0xFFFFFF', fillAlpha: 0.2 };
let appMode = 'VIEW_ALL';
let img = new Image();
let apartments = [];
let drawingPoints = [];
let selectedAptIndex = -1;
let selectedPointIndex = -1;
let isDragging = false;
let pendingPointClick = null;
const DRAG_THRESHOLD = 4;
let zoomLevel = 1.0;
const HANDLE_RADIUS = 6;

// File System State
let projectDirHandle = null;
let xmlFileHandle = null;
let originalXmlContent = "";
let sceneDataMap = {};

// Panning State
let isPanning = false;
let startPanX = 0, startPanY = 0;
let startScrollLeft = 0, startScrollTop = 0;
let spacePressed = false;

const editorView = document.getElementById('editorView');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const aptListEl = document.getElementById('aptList');

// --- INITIALIZATION ---
function initApp(mode) {
    currentWorkflow = mode;
    document.getElementById('welcomeScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'flex';

    if (mode === 'image') {
        document.getElementById('headerTitle').innerText = "Image workspace";
        document.getElementById('panelImageSetup').style.display = 'block';
        document.getElementById('panelExportImage').style.display = 'block';
        drawHelperText("Upload an Image from the left panel to begin.");
    } else {
        document.getElementById('headerTitle').innerText = "Project workspace";
        document.getElementById('panelFolderSetup').style.display = 'block';
        document.getElementById('panelExportFolder').style.display = 'block';
        drawHelperText("Click 'Open Krpano Folder' to begin.");
    }
}

function drawHelperText(text) {
    document.getElementById('canvasEmpty').hidden = false;
    document.getElementById('canvasWrapper').hidden = true;
    document.getElementById('canvasEmptyText').textContent = text;
}

// --- IMAGE LOADING ENGINE ---
// Universal image onload handler to calculate everything properly
img.onload = () => {
    document.getElementById('canvasEmpty').hidden = true;
    document.getElementById('canvasWrapper').hidden = false;
    document.getElementById('imageDimensions').textContent = `${img.naturalWidth.toLocaleString()} × ${img.naturalHeight.toLocaleString()} px`;
    document.getElementById('folderStatus').textContent = 'Image loaded';
    fitToScreen();
    updateUI();
    if (currentWorkflow === 'folder' && originalXmlContent) {
        loadExistingHotspotsFromXML();
    }
};

// Workflow A: Image Input
document.getElementById('standaloneImageInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('canvasTitle').textContent = file.name;
    document.getElementById('prefixImage').value = file.name.replace(/\.[^/.]+$/, "") + "_";
    const reader = new FileReader();
    reader.onload = (evt) => { img.src = evt.target.result; };
    reader.readAsDataURL(file);
});

// Workflow B: High-Res Override
document.getElementById('highResOverride').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => { img.src = evt.target.result; };
    reader.readAsDataURL(file);
});

// --- WORKFLOW A: EXPORT ---
function getImageExportSettings() {
    if (!img.complete || !img.naturalWidth || !img.naturalHeight) {
        throw new Error('Upload an image before copying hotspot XML.');
    }
    const hfov = Number(document.getElementById('hfovImg').value);
    const vfov = Number(document.getElementById('vfovImg').value);
    if (!Number.isFinite(hfov) || !Number.isFinite(vfov) || hfov <= 0 || vfov <= 0) {
        throw new Error('Enter valid positive HFOV and VFOV values.');
    }
    return { hfov, vfov, prefix: document.getElementById('prefixImage').value, ...readHotspotStyle() };
}

function escapeXmlAttribute(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generateHotspotXml(apt, { hfov, vfov, prefix, borderColor, fillColor, fillAlpha }) {
    let xml = `\t\t<hotspot name="${escapeXmlAttribute(prefix + apt.number)}" style="mypolygonalhotspotstylename"\n\t\t\tbordercolor="${borderColor}" borderwidth="1"\n\t\t\tfillcolor="${fillColor}" fillalpha="${fillAlpha}" capture="false"\n\t\t\tzorder="5"\n\t\t\tonhover="set(fillalpha, 0.5);"\n\t\t\tonout="set(fillalpha, ${fillAlpha});">\n`;
    apt.points.forEach(point => {
        const ath = ((point.x / img.width) - 0.5) * hfov;
        const atv = ((point.y / img.height) - 0.5) * vfov;
        xml += `\t\t\t<point ath="${ath.toFixed(6)}" atv="${atv.toFixed(6)}" />\n`;
    });
    return xml + '\t\t</hotspot>\n';
}

function generateAllHotspotXml() {
    const settings = getImageExportSettings();
    return apartments.map(apt => generateHotspotXml(apt, settings)).join('');
}

function updateCopyStatus(message) {
    document.getElementById('copyStatus').textContent = message;
}

async function copyXml(xml, description) {
    try {
        await navigator.clipboard.writeText(xml);
        updateCopyStatus(`${description} copied to clipboard.`);
    } catch (error) {
        updateCopyStatus(`Could not copy ${description.toLowerCase()}. Check clipboard permission and try again.`);
    }
}

document.getElementById('btnGenerateCode').addEventListener('click', () => {
    if (apartments.length === 0) return alert('Please draw at least one hotspot!');
    try {
        document.getElementById('xmlOutput').value = generateAllHotspotXml();
        document.getElementById('btnCopyAllXml').disabled = false;
        updateCopyStatus('');
    } catch (error) {
        updateCopyStatus(error.message);
    }
});

document.getElementById('btnCopyAllXml').addEventListener('click', () => {
    const xml = document.getElementById('xmlOutput').value;
    if (xml) copyXml(xml, 'All generated XML');
});

// --- WORKFLOW B: FOLDER LOGIC ---
document.getElementById('btnOpenFolder').addEventListener('click', async () => {
    try {
        projectDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        document.getElementById('folderStatus').innerText = "📁 " + projectDirHandle.name;

        try {
            xmlFileHandle = await projectDirHandle.getFileHandle('tour.xml', { create: false });
            const file = await xmlFileHandle.getFile();
            originalXmlContent = await file.text();

            document.getElementById('folderControls').style.display = 'block';
            parseScenesFromXML(originalXmlContent);
        } catch (err) {
            alert("Error: 'tour.xml' not found in this folder.");
        }
    } catch (err) {
        if (err.name !== 'AbortError') alert("Folder access denied.");
    }
});

function parseScenesFromXML(xmlText) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");
    const scenes = xmlDoc.getElementsByTagName("scene");

    const select = document.getElementById('sceneSelect');
    select.replaceChildren();
    sceneDataMap = {};

    for (let i = 0; i < scenes.length; i++) {
        const sceneName = scenes[i].getAttribute("name");
        if (sceneName) {
            let imgUrl = "";
            const preview = scenes[i].getElementsByTagName("preview")[0];
            if (preview && preview.getAttribute("url")) {
                imgUrl = preview.getAttribute("url");
            }
            sceneDataMap[sceneName] = { url: imgUrl };
            let option = document.createElement('option');
            option.value = sceneName; option.text = sceneName;
            select.appendChild(option);
        }
    }
    if (scenes.length > 0) onSceneChange();
}

async function onSceneChange() {
    const select = document.getElementById('sceneSelect');
    if (select.value) {
        document.getElementById('canvasTitle').textContent = select.value;
        document.getElementById('prefixFolder').value = select.value + "_";
        const imgPath = sceneDataMap[select.value].url;

        apartments = [];
        updateUI();

        if (imgPath) {
            drawHelperText("Loading preview image & checking for existing hotspots...");
            await loadLocalImage(imgPath);
        } else {
            img.src = "";
            drawHelperText("No preview image found in XML for this scene. Upload a High-Res Image to continue.");
        }
    }
}

async function loadLocalImage(path) {
    try {
        const pathParts = path.split('/');
        let currentDir = projectDirHandle;
        for (let i = 0; i < pathParts.length - 1; i++) {
            currentDir = await currentDir.getDirectoryHandle(pathParts[i]);
        }
        const fileHandle = await currentDir.getFileHandle(pathParts[pathParts.length - 1]);
        const file = await fileHandle.getFile();
        const objectUrl = URL.createObjectURL(file);
        // This will trigger img.onload which will fit screen and parse existing hotspots
        img.src = objectUrl;
    } catch (err) {
        drawHelperText("Could not auto-load image. Please upload a High-Res Override.");
    }
}

// --- REVERSE MATH: LOAD EXISTING HOTSPOTS ---
function loadExistingHotspotsFromXML() {
    if (!originalXmlContent || !img.src || img.src === "") return;
    const selectedScene = document.getElementById('sceneSelect').value;
    if (!selectedScene) return;

    // Parse XML DOM
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(originalXmlContent, "text/xml");
    const scenes = xmlDoc.getElementsByTagName("scene");

    let targetScene = null;
    for (let i = 0; i < scenes.length; i++) {
        if (scenes[i].getAttribute("name") === selectedScene) { targetScene = scenes[i]; break; }
    }
    if (!targetScene) return;

    const hfov = parseFloat(document.getElementById('hfovFol').value);
    const vfov = parseFloat(document.getElementById('vfovFol').value);
    const prefix = document.getElementById('prefixFolder').value;

    apartments = [];
    const hotspots = targetScene.getElementsByTagName("hotspot");

    for (let i = 0; i < hotspots.length; i++) {
        const hs = hotspots[i];
        const points = hs.getElementsByTagName("point");

        // Only parse if it's a polygon (has <point> children)
        if (points.length > 2) {
            let name = hs.getAttribute("name") || "unknown";
            if (name.startsWith(prefix)) name = name.substring(prefix.length);

            let ptsArray = [];
            for (let j = 0; j < points.length; j++) {
                let ath = parseFloat(points[j].getAttribute("ath"));
                let atv = parseFloat(points[j].getAttribute("atv"));

                // The Magical Reverse Math [Pixels to Spherical reversed]
                let x = ((ath / hfov) + 0.5) * img.width;
                let y = ((atv / vfov) + 0.5) * img.height;
                ptsArray.push({ x: x, y: y });
            }

            apartments.push({
                id: Date.now() + Math.random(),
                number: name,
                points: ptsArray
            });
        }
    }
    updateUI();
    redraw();
}

// --- WORKFLOW B: SAVE OVERWRITE XML ---
document.getElementById('btnSaveXML').addEventListener('click', async () => {
    if (!xmlFileHandle || !originalXmlContent) return alert("Please open a project folder first!");

    const hfov = parseFloat(document.getElementById('hfovFol').value);
    const vfov = parseFloat(document.getElementById('vfovFol').value);
    const prefix = document.getElementById('prefixFolder').value;
    const selectedScene = document.getElementById('sceneSelect').value;

    if (!selectedScene) return alert("Please select a target scene.");

    let hotspotXml;
    try {
        if (!img.naturalWidth || !img.naturalHeight || !Number.isFinite(hfov) || !Number.isFinite(vfov) || hfov <= 0 || vfov <= 0) {
            throw new Error('Load an image and enter valid positive HFOV and VFOV values before saving.');
        }
        const settings = { hfov, vfov, prefix, ...readHotspotStyle() };
        hotspotXml = apartments.map(apt => generateHotspotXml(apt, settings)).join('');
    } catch (error) {
        document.getElementById('exportStyleStatus').textContent = error.message;
        return;
    }

    // Smart Regex Replacement: 
    // 1. Find the target Scene
    // 2. Remove ONLY existing polygonal hotspots inside it (hotspots with <point> tags)
    // 3. Inject our fresh hotspot list.
    const sceneRegex = new RegExp(`(<scene[^>]*name=["']${selectedScene}["'][^>]*>)([\\s\\S]*?)(</scene>)`, 'i');

    if (sceneRegex.test(originalXmlContent)) {
        let match = sceneRegex.exec(originalXmlContent);
        let sceneStart = match[1];
        let sceneBody = match[2];
        let sceneEnd = match[3];

        // Strip existing polygonal hotspots safely
        let cleanSceneBody = sceneBody.replace(/<hotspot[^>]*>[\s\S]*?<point[\s\S]*?<\/hotspot>/gi, '');

        // Re-assemble XML
        let updatedXml = originalXmlContent.replace(sceneRegex, `${sceneStart}${cleanSceneBody}\n\t\t<!-- Inject Editor Hotspots -->\n${hotspotXml}\n\t${sceneEnd}`);

        try {
            const writable = await xmlFileHandle.createWritable();
            await writable.write(updatedXml);
            await writable.close();
            originalXmlContent = updatedXml; // Keep memory in sync
            alert(`✅ Success! Hotspots perfectly overwritten and saved into ${selectedScene} in tour.xml`);
        } catch (err) {
            alert("Save failed. Ensure tour.xml is not open/locked in another program.");
        }
    } else {
        alert(`Error: Could not find the closing </scene> tag for "${selectedScene}".`);
    }
});

// --- PANNING, ZOOMING, & DRAWING ENGINE ---
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT') {
        spacePressed = true; canvas.style.cursor = 'grab'; e.preventDefault();
    }
});
window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spacePressed = false; canvas.style.cursor = 'crosshair'; }
});
canvas.addEventListener('contextmenu', e => e.preventDefault());

function setZoom(newZoom) {
    zoomLevel = Math.max(0.05, Math.min(5.0, newZoom));
    document.getElementById('zoomLabel').innerText = Math.round(zoomLevel * 100) + '%';
    if (img.src) { canvas.width = img.width * zoomLevel; canvas.height = img.height * zoomLevel; redraw(); }
}
function fitToScreen() {
    if (!img.src) return;
    const scaleX = (editorView.clientWidth - 40) / img.width; const scaleY = (editorView.clientHeight - 40) / img.height;
    setZoom(Math.min(scaleX, scaleY) || 1.0);
}
document.getElementById('btnZoomIn').addEventListener('click', () => setZoom(zoomLevel * 1.25));
document.getElementById('btnZoomOut').addEventListener('click', () => setZoom(zoomLevel / 1.25));
document.getElementById('btnZoomFit').addEventListener('click', fitToScreen);
canvas.addEventListener('wheel', (e) => { if (e.ctrlKey) return; e.preventDefault(); setZoom(e.deltaY < 0 ? zoomLevel * 1.1 : zoomLevel / 1.1); });

function redraw() {
    if (!img.src || img.src === "") return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const selected = appMode === 'VIEW_SINGLE' ? apartments[selectedAptIndex] : null;
    apartments.forEach(apt => {
        if (apt.visible !== false && apt !== selected) drawPolygon(apt, false);
    });
    if (selected && selected.visible !== false) drawPolygon(selected, true);

    if (appMode === 'DRAWING' && drawingPoints.length > 0) {
        ctx.beginPath(); ctx.moveTo(drawingPoints[0].x * zoomLevel, drawingPoints[0].y * zoomLevel);
        for (let i = 1; i < drawingPoints.length; i++) ctx.lineTo(drawingPoints[i].x * zoomLevel, drawingPoints[i].y * zoomLevel);
        ctx.strokeStyle = "#FFD700"; ctx.lineWidth = 2; ctx.stroke();
        drawingPoints.forEach(pt => {
            ctx.beginPath(); ctx.arc(pt.x * zoomLevel, pt.y * zoomLevel, HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = "#FF0000"; ctx.fill(); ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 1.5; ctx.stroke();
        });
    }
}

function drawPolygon(apt, isSelected) {
    if (apt.points.length === 0) return;
    ctx.beginPath(); ctx.moveTo(apt.points[0].x * zoomLevel, apt.points[0].y * zoomLevel);
    for (let i = 1; i < apt.points.length; i++) ctx.lineTo(apt.points[i].x * zoomLevel, apt.points[i].y * zoomLevel);
    ctx.closePath();
    ctx.save();
    ctx.fillStyle = hotspotStyle.fillColor.replace('0x', '#');
    ctx.globalAlpha = hotspotStyle.fillAlpha;
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = isSelected ? '#b9f582' : hotspotStyle.borderColor.replace('0x', '#');
    ctx.lineWidth = isSelected ? 3 : 1;
    ctx.stroke();

    let cx = 0, cy = 0; apt.points.forEach(p => { cx += p.x; cy += p.y; }); cx /= apt.points.length; cy /= apt.points.length;
    ctx.fillStyle = "#FFFFFF"; ctx.font = "bold " + Math.max(12, Math.min(18, 14 * zoomLevel)) + "px Arial";
    ctx.shadowColor = "black"; ctx.shadowBlur = 4; ctx.fillText(apt.number, (cx * zoomLevel) - 10, (cy * zoomLevel) + 5); ctx.shadowBlur = 0;

    if (isSelected) {
        apt.points.forEach((pt, pIdx) => {
            ctx.beginPath(); ctx.arc(pt.x * zoomLevel, pt.y * zoomLevel, HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = (pIdx === selectedPointIndex) ? "#FF0000" : "#00E5FF"; ctx.fill();
            ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 1.5; ctx.stroke();
        });
    }
}

function getCanvasMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) * (canvas.width / rect.width)) / zoomLevel, y: ((e.clientY - rect.top) * (canvas.height / rect.height)) / zoomLevel };
}

canvas.addEventListener('mousedown', (e) => {
    if (!img.src) return;
    if (e.button === 2) {
        const points = appMode === 'DRAWING'
            ? drawingPoints
            : appMode === 'VIEW_SINGLE' ? apartments[selectedAptIndex]?.points : null;
        const pos = getCanvasMousePos(e);
        // Check newest points first so overlapping closing points can be removed individually.
        const pointIndex = points?.findLastIndex(point =>
            Math.hypot((point.x - pos.x) * zoomLevel, (point.y - pos.y) * zoomLevel) <= HANDLE_RADIUS + 4
        ) ?? -1;
        if (pointIndex !== -1) {
            e.preventDefault();
            pendingPointClick = null;
            isDragging = false;
            if (appMode === 'VIEW_SINGLE' && points.length <= 3) {
                alert('A finished polygon needs at least 3 points.');
                return;
            }
            points.splice(pointIndex, 1);
            selectedPointIndex = -1;
            canvas.style.cursor = spacePressed ? 'grab' : 'crosshair';
            updateUI();
            redraw();
            return;
        }
    }
    if (e.button === 1 || e.button === 2 || (spacePressed && e.button === 0)) {
        isPanning = true; startPanX = e.pageX; startPanY = e.pageY;
        startScrollLeft = editorView.scrollLeft; startScrollTop = editorView.scrollTop;
        canvas.style.cursor = 'grabbing'; e.preventDefault(); return;
    }
    if (e.button !== 0) return;
    const pos = getCanvasMousePos(e);

    if (appMode === 'DRAWING') {
        selectedPointIndex = drawingPoints.findIndex(point =>
            Math.hypot((point.x - pos.x) * zoomLevel, (point.y - pos.y) * zoomLevel) <= HANDLE_RADIUS + 4
        );
        if (selectedPointIndex !== -1) {
            pendingPointClick = { clientX: e.clientX, clientY: e.clientY, point: { ...drawingPoints[selectedPointIndex] } };
            e.preventDefault();
        } else {
            drawingPoints.push(pos);
        }
        redraw();
        return;
    }

    if (appMode === 'VIEW_SINGLE' && selectedAptIndex !== -1) {
        const apt = apartments[selectedAptIndex];
        for (let i = 0; i < apt.points.length; i++) {
            if (Math.hypot((apt.points[i].x - pos.x) * zoomLevel, (apt.points[i].y - pos.y) * zoomLevel) <= HANDLE_RADIUS + 4) {
                selectedPointIndex = i; isDragging = true; redraw(); return;
            }
        }
    }

    let clickedOnShape = false;
    if (appMode === 'VIEW_ALL') {
        for (let i = 0; i < apartments.length; i++) {
            if (apartments[i].visible === false) continue;
            let inside = false; let pts = apartments[i].points;
            for (let j = 0, k = pts.length - 1; j < pts.length; k = j++) {
                let xi = pts[j].x, yi = pts[j].y, xj = pts[k].x, yj = pts[k].y;
                if (((yi > pos.y) !== (yj > pos.y)) && (pos.x < (xj - xi) * (pos.y - yi) / (yj - yi) + xi)) inside = !inside;
            }
            if (inside) { selectedAptIndex = i; appMode = 'VIEW_SINGLE'; clickedOnShape = true; updateUI(); redraw(); return; }
        }
    }

    if (!clickedOnShape && appMode !== 'DRAWING') {
        selectedAptIndex = -1; selectedPointIndex = -1;
        isPanning = true; startPanX = e.pageX; startPanY = e.pageY;
        startScrollLeft = editorView.scrollLeft; startScrollTop = editorView.scrollTop;
        canvas.style.cursor = 'grabbing'; updateUI(); redraw();
    }
});

window.addEventListener('mousemove', (e) => {
    if (isPanning) { editorView.scrollLeft = startScrollLeft - (e.pageX - startPanX); editorView.scrollTop = startScrollTop - (e.pageY - startPanY); return; }
    if (pendingPointClick && appMode === 'DRAWING') {
        const distance = Math.hypot(e.clientX - pendingPointClick.clientX, e.clientY - pendingPointClick.clientY);
        if (distance < DRAG_THRESHOLD) return;
        pendingPointClick = null;
        isDragging = true;
        canvas.style.cursor = 'grabbing';
    }
    if (!isDragging) return;
    const points = appMode === 'DRAWING'
        ? drawingPoints
        : appMode === 'VIEW_SINGLE' ? apartments[selectedAptIndex]?.points : null;
    if (!points || !points[selectedPointIndex]) return;
    const pos = getCanvasMousePos(e);
    points[selectedPointIndex] = {
        x: Math.max(0, Math.min(img.width, pos.x)),
        y: Math.max(0, Math.min(img.height, pos.y))
    };
    redraw();
});

window.addEventListener('mouseup', (e) => {
    if (e.button !== 0 && pendingPointClick) return;
    if (pendingPointClick && appMode === 'DRAWING') {
        drawingPoints.push(pendingPointClick.point);
        redraw();
    }
    pendingPointClick = null;
    isPanning = false;
    isDragging = false;
    canvas.style.cursor = spacePressed ? 'grab' : 'crosshair';
});
window.addEventListener('blur', () => {
    pendingPointClick = null;
    isPanning = false;
    isDragging = false;
    spacePressed = false;
    canvas.style.cursor = 'crosshair';
});

function getNextHotspotNumber() {
    let number = apartments.length + 1;
    const names = new Set(apartments.map(apt => String(apt.number)));
    while (names.has(String(number))) number++;
    return String(number);
}

function renameHotspot(apt, label) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'hotspot-name-input';
    input.value = apt.number;
    input.required = true;
    input.setAttribute('aria-label', 'Hotspot name');
    let finished = false;
    function finishRename(save, showError = false) {
        if (finished) return;
        const name = input.value.trim();
        const duplicate = apartments.some(other => other !== apt && String(other.number) === name);
        input.setCustomValidity(!name ? 'Enter a hotspot name.' : duplicate ? 'This hotspot name is already in use.' : '');
        if (save && showError && !input.reportValidity()) return;
        finished = true;
        if (save && name && !duplicate) apt.number = name;
        updateUI();
        redraw();
    }
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Enter' || event.key === 'Escape') {
            event.preventDefault();
            finishRename(event.key === 'Enter', event.key === 'Enter');
        }
    });
    input.addEventListener('blur', () => finishRename(true));
    label.replaceChildren(input);
    input.focus();
    input.select();
}

function updateUI() {
    document.getElementById('hotspotCount').textContent = apartments.length;
    document.getElementById('hotspotEmpty').hidden = apartments.length > 0;
    const selected = apartments[selectedAptIndex];
    const status = appMode === 'DRAWING' ? 'Drawing a new polygon'
        : appMode === 'VIEW_SINGLE' && selected ? `Editing hotspot ${selected.number}`
        : apartments.length ? `${apartments.length} hotspots on canvas` : 'Ready when you are';
    document.getElementById('canvasStatusText').textContent = status;
    document.getElementById('btnDeleteApt').disabled = selectedAptIndex < 0 || appMode === 'DRAWING';
    document.getElementById('drawControls').style.display = (appMode === 'DRAWING') ? 'block' : 'none';
    document.getElementById('defaultControls').style.display = (appMode !== 'DRAWING') ? 'block' : 'none';

    aptListEl.replaceChildren();
    apartments.forEach((apt, idx) => {
        const row = document.createElement('div');
        row.className = `apt-item ${(idx === selectedAptIndex && appMode === 'VIEW_SINGLE') ? 'selected' : ''}`;
        const label = document.createElement('span');
        label.className = 'apt-item-label';
        const name = document.createElement('strong');
        name.textContent = apt.number;
        label.append('Apt ', name, ` (${apt.points.length} pts)`);
        const visibilityToggle = document.createElement('input');
        visibilityToggle.type = 'checkbox';
        visibilityToggle.className = 'hotspot-visibility-toggle';
        visibilityToggle.setAttribute('role', 'switch');
        visibilityToggle.setAttribute('aria-label', `Show hotspot ${apt.number}`);
        visibilityToggle.checked = apt.visible !== false;
        visibilityToggle.addEventListener('click', event => event.stopPropagation());
        visibilityToggle.addEventListener('change', () => {
            apt.visible = visibilityToggle.checked;
            if (!apt.visible && selectedAptIndex === idx) {
                selectedAptIndex = -1;
                selectedPointIndex = -1;
                isDragging = false;
                if (appMode === 'VIEW_SINGLE') appMode = 'VIEW_ALL';
                updateUI();
            }
            redraw();
        });
        const renameButton = document.createElement('button');
        renameButton.type = 'button';
        renameButton.className = 'secondary apt-rename-button';
        renameButton.textContent = '✎';
        renameButton.title = 'Rename hotspot';
        renameButton.setAttribute('aria-label', `Rename hotspot ${apt.number}`);
        renameButton.addEventListener('click', event => {
            event.stopPropagation();
            renameHotspot(apt, label);
        });
        row.append(visibilityToggle, label, renameButton);
        row.addEventListener('click', () => {
            if (appMode === 'DRAWING') return;
            apt.visible = true;
            selectedAptIndex = idx; selectedPointIndex = -1;
            appMode = 'VIEW_SINGLE'; updateUI(); redraw();
        });
        if (currentWorkflow === 'image') {
            const copyButton = document.createElement('button');
            copyButton.type = 'button';
            copyButton.className = 'secondary apt-copy-button';
            copyButton.textContent = 'Copy XML';
            copyButton.setAttribute('aria-label', `Copy XML for hotspot ${apt.number}`);
            copyButton.addEventListener('click', event => {
                event.stopPropagation();
                try {
                    copyXml(generateHotspotXml(apt, getImageExportSettings()), `Hotspot ${apt.number} XML`);
                } catch (error) {
                    updateCopyStatus(error.message);
                }
            });
            row.append(copyButton);
        }
        aptListEl.appendChild(row);
    });
}

document.getElementById('btnShowAll').addEventListener('click', () => {
    apartments.forEach(apt => { apt.visible = true; });
    if (appMode !== 'DRAWING') {
        appMode = 'VIEW_ALL';
        selectedAptIndex = -1;
        selectedPointIndex = -1;
    }
    updateUI();
    redraw();
});
document.getElementById('btnStartDraw').addEventListener('click', () => { if (!img.src) return alert("Select a scene to load an image first!"); appMode = 'DRAWING'; drawingPoints = []; updateUI(); redraw(); });
document.getElementById('btnCancelDraw').addEventListener('click', () => { appMode = 'VIEW_ALL'; drawingPoints = []; updateUI(); redraw(); });
document.getElementById('btnFinishDraw').addEventListener('click', () => {
    if (drawingPoints.length < 3) return alert("A polygon needs at least 3 points!");
    const num = getNextHotspotNumber();
    apartments.push({ id: Date.now(), number: num, points: [...drawingPoints] });
    selectedAptIndex = apartments.length - 1; appMode = 'VIEW_SINGLE'; drawingPoints = []; updateUI(); redraw();
});
document.getElementById('btnDeleteApt').addEventListener('click', () => {
    if (selectedAptIndex === -1) return alert("Select a hotspot from the list first to delete it.");
    apartments.splice(selectedAptIndex, 1); appMode = 'VIEW_ALL'; selectedAptIndex = -1; updateUI(); redraw();
});

document.querySelectorAll('[data-workflow]').forEach(button => {
    button.addEventListener('click', () => initApp(button.dataset.workflow));
});
document.getElementById('btnBack').addEventListener('click', () => {
    if (apartments.length && !window.confirm('Return to workflow selection? Unsaved hotspots will be cleared.')) return;
    location.reload();
});
document.getElementById('sceneSelect').addEventListener('change', onSceneChange);
updateUI();

function normalizeHotspotColor(value, label) {
    const match = value.trim().match(/^(?:0x|#)?([0-9a-f]{6})$/i);
    if (!match) throw new Error(`${label} needs a six-digit hex color, such as 0xFFFFFF.`);
    return `0x${match[1].toUpperCase()}`;
}

function readHotspotStyle() {
    const borderColor = normalizeHotspotColor(document.getElementById('borderColorCode').value, 'Border color');
    const fillColor = normalizeHotspotColor(document.getElementById('fillColorCode').value, 'Fill color');
    const opacityInput = document.getElementById('fillOpacity');
    const opacity = Number(opacityInput.value);
    if (opacityInput.value.trim() === '' || !Number.isFinite(opacity) || opacity < 0 || opacity > 100) {
        throw new Error('Fill opacity must be between 0% and 100%.');
    }
    return { borderColor, fillColor, fillAlpha: opacity / 100 };
}

function applyHotspotStyle() {
    const status = document.getElementById('exportStyleStatus');
    const copyAll = document.getElementById('btnCopyAllXml');
    try {
        hotspotStyle = readHotspotStyle();
        document.getElementById('borderColorPicker').value = hotspotStyle.borderColor.replace('0x', '#');
        document.getElementById('fillColorPicker').value = hotspotStyle.fillColor.replace('0x', '#');
        document.getElementById('fillOpacityRange').value = hotspotStyle.fillAlpha * 100;
        status.textContent = '';
        const output = document.getElementById('xmlOutput');
        if (output.value && currentWorkflow === 'image') {
            output.value = generateAllHotspotXml();
            copyAll.disabled = false;
            updateCopyStatus('XML updated with your style changes.');
        }
        redraw();
    } catch (error) {
        status.textContent = error.message;
        copyAll.disabled = true;
    }
}

['border', 'fill'].forEach(kind => {
    const picker = document.getElementById(`${kind}ColorPicker`);
    const code = document.getElementById(`${kind}ColorCode`);
    picker.addEventListener('input', () => {
        code.value = picker.value.replace('#', '0x').toUpperCase().replace('0X', '0x');
        applyHotspotStyle();
    });
    code.addEventListener('input', applyHotspotStyle);
    code.addEventListener('change', () => {
        try { code.value = normalizeHotspotColor(code.value, `${kind} color`); }
        catch { return; } // Keep incomplete input available for correction.
        applyHotspotStyle();
    });
});
document.getElementById('fillOpacityRange').addEventListener('input', event => {
    document.getElementById('fillOpacity').value = event.target.value;
    applyHotspotStyle();
});
document.getElementById('fillOpacity').addEventListener('input', applyHotspotStyle);
