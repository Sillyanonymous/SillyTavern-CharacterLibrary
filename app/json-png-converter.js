export function openConverterModal() {
    if (!document.getElementById('st-converter-styles')) {
        const style = document.createElement('style');
        style.id = 'st-converter-styles';
        style.textContent = `
            .converter-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: var(--SmartThemeBlurTintColor, rgba(30, 30, 35, 0.95)); border: 1px solid rgba(255,255,255,0.1); padding: 25px; z-index: 40000; border-radius: 12px; width: 450px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); backdrop-filter: blur(10px); color: var(--cl-text-primary, var(--SmartThemeBodyColor, #e0e0e0)); font-family: inherit; }
            .converter-modal h3 { margin: 0 0 15px 0; color: var(--cl-text-primary, var(--SmartThemeBodyColor, #e0e0e0)); border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
            .converter-zone { border: 2px dashed var(--border-color, rgba(255,255,255,0.2)); padding: 25px; text-align: center; margin: 15px 0; border-radius: 8px; cursor: pointer; transition: 0.2s; font-size: 14px; color: var(--cl-text-secondary, rgba(255,255,255,0.6)); }
            .converter-zone:hover, .converter-zone.dragover { border-color: var(--SmartThemeQuoteColor, #4a90e2); background: rgba(255,255,255,0.05); color: var(--cl-text-primary, var(--SmartThemeBodyColor, #e0e0e0)); }
            .converter-zone.ready { border-color: #4caf50; border-style: solid; background: rgba(76,175,80,0.05); color: #4caf50; font-weight: 500; }
            .converter-zone i { font-size: 24px; margin-bottom: 8px; display: block; opacity: 0.8; }
            .converter-btn { background: var(--SmartThemeQuoteColor, #4a90e2); color: #fff; border: none; padding: 12px; width: 100%; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 14px; margin-top: 10px; transition: 0.2s; }
            .converter-btn:hover:not(:disabled) { opacity: 0.9; transform: translateY(-1px); }
            .converter-btn:disabled { background: var(--button-disabled, rgba(255,255,255,0.1)); color: var(--text-color-light, rgba(255,255,255,0.5)); cursor: not-allowed; }
            .converter-close { position: absolute; right: 20px; top: 20px; cursor: pointer; opacity: 0.6; font-size: 16px; transition: 0.2s; }
            .converter-close:hover { opacity: 1; color: #ff5252; }
            .converter-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 39999; backdrop-filter: blur(3px); }
        `;
        document.head.appendChild(style);
    }

    const overlay = document.createElement('div');
    overlay.className = 'converter-overlay';
    
    const modal = document.createElement('div');
    modal.className = 'converter-modal';
    modal.innerHTML = `
        <i class="fa-solid fa-xmark converter-close" id="conv-close"></i>
        <h3><i class="fa-solid fa-file-export"></i> JSON to PNG Converter</h3>
        <p style="font-size:13px; color:var(--text-color-light, rgba(255,255,255,0.6)); margin-bottom: 20px;">Embed character data into a PNG file to create a valid SillyTavern character card.</p>
        <div class="converter-zone" id="conv-json-zone">
            <i class="fa-solid fa-file-code"></i>
            <div>Click or Drop Character .json</div>
            <input type="file" id="conv-json" accept=".json" style="display:none">
        </div>
        <div class="converter-zone" id="conv-png-zone">
            <i class="fa-solid fa-image"></i>
            <div>Click or Drop Base Image (.png)</div>
            <input type="file" id="conv-png" accept="image/png" style="display:none">
        </div>
        <button class="converter-btn" id="conv-btn" disabled><i class="fa-solid fa-wand-magic-sparkles"></i> Generate Character Card</button>
    `;
    
    document.body.appendChild(overlay);
    document.body.appendChild(modal);

    const closeModal = () => { overlay.remove(); modal.remove(); };
    overlay.onclick = closeModal;
    modal.querySelector('#conv-close').onclick = closeModal;

    let jsonFile = null, pngFile = null;
    
    const setupZone = (zoneId, inputId, type) => {
        const zone = modal.querySelector('#'+zoneId);
        const input = modal.querySelector('#'+inputId);
        zone.onclick = () => input.click();
        zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('dragover'); };
        zone.ondragleave = () => zone.classList.remove('dragover');
        zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('dragover'); if(e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); };
        input.onchange = (e) => { if(e.target.files[0]) handle(e.target.files[0]); };
        
        function handle(f) {
            if(!f.name.toLowerCase().endsWith('.'+type)) return alert('Please select a '+type.toUpperCase()+' file.');
            if(type === 'json') {
                jsonFile = f;
                zone.innerHTML = '<i class="fa-solid fa-check"></i><div>' + f.name + '</div>';
            } else {
                pngFile = f;
                zone.innerHTML = '<i class="fa-solid fa-check"></i><div>' + f.name + '</div>';
            }
            zone.classList.add('ready');
            modal.querySelector('#conv-btn').disabled = !(jsonFile && pngFile);
        }
    };
    
    setupZone('conv-json-zone', 'conv-json', 'json');
    setupZone('conv-png-zone', 'conv-png', 'png');

    const crcTable = [];
    for(let n=0; n<256; n++){ let c=n; for(let k=0; k<8; k++){ c = c&1 ? 0xedb88320^(c>>>1) : c>>>1; } crcTable[n]=c; }
    const crc32 = (buf) => { let c=0^-1; for(let i=0; i<buf.length; i++) c = crcTable[(c^buf[i])&0xff]^(c>>>8); return (c^-1)>>>0; };

    modal.querySelector('#conv-btn').onclick = async function() {
        const btn = this;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...'; 
        btn.disabled = true;
        try {
            const jText = await jsonFile.text(); 
            const iBuf = await pngFile.arrayBuffer();
            let cData = JSON.parse(jText);
            
            const u8 = new TextEncoder().encode(jText);
            let bin = ""; for(let i=0; i<u8.length; i+=8192) bin += String.fromCharCode.apply(null, u8.subarray(i, i+8192));
            const b64 = btoa(bin);

            const txt = new TextEncoder().encode("chara\0" + b64);
            const typ = new TextEncoder().encode("tEXt");
            const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, txt.length, false);
            const dat = new Uint8Array(4+txt.length); dat.set(typ,0); dat.set(txt,4);
            const crc = new Uint8Array(4); new DataView(crc.buffer).setUint32(0, crc32(dat), false);
            
            const chunk = new Uint8Array(8+txt.length+4);
            chunk.set(len,0); chunk.set(typ,4); chunk.set(txt,8); chunk.set(crc,8+txt.length);

            const orig = new Uint8Array(iBuf);
            if(orig[0]!==137 || orig[1]!==80 || orig[2]!==78 || orig[3]!==71) throw new Error("Not a valid PNG image");
            const final = new Uint8Array(33 + chunk.length + (orig.length-33));
            final.set(orig.slice(0,33), 0); final.set(chunk, 33); final.set(orig.slice(33), 33+chunk.length);

            const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([final], {type: 'image/png'}));
            let name = cData.name || (cData.data && cData.data.name) || "character";
            a.download = name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '_card.png';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            
            btn.innerHTML = '<i class="fa-solid fa-check"></i> Card Generated!'; 
            setTimeout(() => { closeModal(); }, 1500);
        } catch(e) { 
            alert("Error: " + e.message); 
            btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Character Card'; 
            btn.disabled = false; 
        }
    }
}
