const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const rows = 6;
const cols = 8;
let bpm = 120;
let isPlaying = false;
let currentStep = 0;
let nextNoteTime = 0;
let timerID = null;
let buffers = new Array(rows).fill(null);
let robotModes = new Array(rows).fill(false);
let lookahead = 25.0;
let scheduleAheadTime = 0.1;

const dest = audioCtx.createMediaStreamDestination();
// Helper gain node to control master volume if needed
const masterGain = audioCtx.createGain();
masterGain.connect(audioCtx.destination);
masterGain.connect(dest);

// --- UI GENERATION ---
const gridEl = document.getElementById('grid');
const statusMsg = document.getElementById('statusMsg');

for (let i = 0; i < rows; i++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';

    // Controls
    const ctrlDiv = document.createElement('div');
    ctrlDiv.className = 'track-controls';
    
    const recBtn = document.createElement('button');
    recBtn.className = 'rec-btn';
    recBtn.innerText = '● REC';
    recBtn.onclick = () => recordSound(i, recBtn);
    
    const robotBtn = document.createElement('button');
    robotBtn.className = 'robot-btn';
    robotBtn.innerText = 'ROBOT';
    robotBtn.onclick = () => toggleRobot(i, robotBtn);

    ctrlDiv.append(recBtn, robotBtn);
    rowEl.appendChild(ctrlDiv);

    // Steps
    const stepsDiv = document.createElement('div');
    stepsDiv.className = 'steps';
    for (let j = 0; j < cols; j++) {
        const stepBtn = document.createElement('div');
        stepBtn.className = 'step';
        stepBtn.dataset.row = i;
        stepBtn.dataset.col = j;
        stepBtn.onclick = () => stepBtn.classList.toggle('active');
        stepsDiv.appendChild(stepBtn);
    }
    rowEl.appendChild(stepsDiv);
    gridEl.appendChild(rowEl);
}

// --- RECORDING INPUT ---
async function recordSound(rowIndex, btn) {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    
    btn.classList.add('recording');
    btn.innerText = 'STOP';
    statusMsg.innerText = "Listening...";

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        const chunks = [];

        mediaRecorder.ondataavailable = e => chunks.push(e.data);
        
        mediaRecorder.onstop = async () => {
            const blob = new Blob(chunks, { type: 'audio/webm' });
            const arrayBuffer = await blob.arrayBuffer();
            audioCtx.decodeAudioData(arrayBuffer, (decodedBuffer) => {
                buffers[rowIndex] = decodedBuffer;
                btn.classList.remove('recording');
                btn.classList.add('has-sample');
                btn.innerText = 'SAMPLE ' + (rowIndex + 1);
                statusMsg.innerText = "Sample Recorded!";
                stream.getTracks().forEach(track => track.stop());
            });
        };

        mediaRecorder.start();
        
        // Auto stop after 2s
        setTimeout(() => {
            if (mediaRecorder.state === 'recording') mediaRecorder.stop();
        }, 2000);
        
        // Manual stop
        btn.onclick = () => {
            if (mediaRecorder.state === 'recording') mediaRecorder.stop();
            btn.onclick = () => recordSound(rowIndex, btn); 
        };

    } catch (err) {
        alert("Microphone Error. Check permissions.");
        btn.classList.remove('recording');
    }
}

// --- PLAYBACK ENGINE ---
function playSound(rowIndex, time) {
    if (!buffers[rowIndex]) return;

    const source = audioCtx.createBufferSource();
    source.buffer = buffers[rowIndex];

    const gainNode = audioCtx.createGain();
    source.connect(gainNode);

    if (robotModes[rowIndex]) {
        const dist = audioCtx.createWaveShaper();
        dist.curve = makeDistortionCurve(400);
        dist.oversample = '4x';
        gainNode.connect(dist);
        dist.connect(masterGain); 
    } else {
        gainNode.connect(masterGain);
    }

    source.start(time);
}

function makeDistortionCurve(amount) {
    let k = typeof amount === 'number' ? amount : 50,
        n_samples = 44100,
        curve = new Float32Array(n_samples),
        deg = Math.PI / 180,
        i = 0,
        x;
    for ( ; i < n_samples; ++i ) {
        x = i * 2 / n_samples - 1;
        curve[i] = ( 3 + k ) * x * 20 * deg / ( Math.PI + k * Math.abs(x) );
    }
    return curve;
}

function toggleRobot(index, btn) {
    robotModes[index] = !robotModes[index];
    btn.classList.toggle('active');
}

// --- SCHEDULER ---
function nextNote() {
    const secondsPerBeat = 60.0 / bpm;
    nextNoteTime += secondsPerBeat / 2; // 8th notes
    currentStep++;
    if (currentStep === cols) {
        currentStep = 0;
    }
}

function scheduleNote(stepNumber, time) {
    // UI Update
    const drawStep = stepNumber;
    requestAnimationFrame(() => {
        document.querySelectorAll('.step').forEach(s => s.classList.remove('playing'));
        document.querySelectorAll(`.step[data-col="${drawStep}"]`).forEach(s => s.classList.add('playing'));
    });

    // Audio Trigger
    for (let i = 0; i < rows; i++) {
        const stepBtn = document.querySelector(`.step[data-row="${i}"][data-col="${stepNumber}"]`);
        if (stepBtn && stepBtn.classList.contains('active')) {
            playSound(i, time);
        }
    }
}

function scheduler() {
    while (nextNoteTime < audioCtx.currentTime + scheduleAheadTime) {
        scheduleNote(currentStep, nextNoteTime);
        nextNote();
    }
    if (isPlaying) timerID = setTimeout(scheduler, lookahead);
}

// --- CONTROLS ---
document.getElementById('playBtn').addEventListener('click', () => {
    if (isPlaying) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    isPlaying = true;
    currentStep = 0;
    nextNoteTime = audioCtx.currentTime;
    scheduler();
    statusMsg.innerText = "Playing Loop...";
});

document.getElementById('stopBtn').addEventListener('click', () => {
    isPlaying = false;
    clearTimeout(timerID);
    document.querySelectorAll('.step').forEach(s => s.classList.remove('playing'));
    statusMsg.innerText = "Stopped.";
});

document.getElementById('tempo').addEventListener('input', (e) => {
    bpm = e.target.value;
    document.getElementById('tempoVal').innerText = bpm + " BPM";
});

// --- EXPORT LOGIC (MP3 / WAV / WEBM) ---
document.getElementById('exportBtn').addEventListener('click', async () => {
    const format = document.getElementById('formatSelect').value;
    const durationSecs = (60 / bpm) * 0.5 * cols * 4; // 4 loops
    
    statusMsg.innerText = "Exporting... Do not close.";
    
    // We record live output for simplicity and cross-browser support
    const rec = new MediaRecorder(dest.stream);
    const chunks = [];
    
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = async () => {
        // 1. Get raw audio blob from recording
        const webmBlob = new Blob(chunks, { type: 'audio/webm' });
        
        if (format === 'webm') {
            downloadBlob(webmBlob, 'beat.webm');
        } else {
            // Convert to AudioBuffer to process for MP3/WAV
            const arrayBuffer = await webmBlob.arrayBuffer();
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            
            if (format === 'wav') {
                const wavBlob = bufferToWav(audioBuffer);
                downloadBlob(wavBlob, 'beat.wav');
            } else if (format === 'mp3') {
                const mp3Blob = bufferToMp3(audioBuffer);
                downloadBlob(mp3Blob, 'beat.mp3');
            }
        }
        
        // Cleanup
        document.getElementById('stopBtn').click();
        statusMsg.innerText = "Export Complete!";
    };
    
    // Start playback and recording
    if(isPlaying) document.getElementById('stopBtn').click();
    rec.start();
    document.getElementById('playBtn').click();
    
    // Stop after calculated duration
    setTimeout(() => {
        rec.stop();
    }, durationSecs * 1000 + 500); // +500ms buffer
});

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
}

// --- ENCODERS ---

// MP3 Encoder using lamejs
function bufferToMp3(buffer) {
    const channels = 1; // Mono for simplicity
    const sampleRate = buffer.sampleRate;
    const samples = buffer.getChannelData(0);
    
    // Convert Float32 to Int16
    const mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, 128);
    const sampleBlockSize = 1152;
    const mp3Data = [];
    
    const int16Samples = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        // Clamp to [-1, 1] and scale
        let s = Math.max(-1, Math.min(1, samples[i]));
        int16Samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    
    // Encode in chunks
    for (let i = 0; i < int16Samples.length; i += sampleBlockSize) {
        const chunk = int16Samples.subarray(i, i + sampleBlockSize);
        const mp3buf = mp3encoder.encodeBuffer(chunk);
        if (mp3buf.length > 0) mp3Data.push(mp3buf);
    }
    
    const endBuf = mp3encoder.flush();
    if (endBuf.length > 0) mp3Data.push(endBuf);
    
    return new Blob(mp3Data, { type: 'audio/mp3' });
}

// WAV Encoder (Standard header logic)
function bufferToWav(abuffer) {
    const numOfChan = abuffer.numberOfChannels;
    const length = abuffer.length * numOfChan * 2 + 44;
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);
    const channels = [];
    let i, sample;
    let offset = 0;
    let pos = 0;

    // write WAVE header
    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8); // file length - 8
    setUint32(0x45564157); // "WAVE"

    setUint32(0x20746d66); // "fmt " chunk
    setUint32(16); // length = 16
    setUint16(1); // PCM (uncompressed)
    setUint16(numOfChan);
    setUint32(abuffer.sampleRate);
    setUint32(abuffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
    setUint16(numOfChan * 2); // block-align
    setUint16(16); // 16-bit (hardcoded in this writer)

    setUint32(0x61746164); // "data" - chunk
    setUint32(length - pos - 4); // chunk length

    // write interleaved data
    for(i = 0; i < abuffer.numberOfChannels; i++)
        channels.push(abuffer.getChannelData(i));

    while(pos < abuffer.length) {
        for(i = 0; i < numOfChan; i++) {
            sample = Math.max(-1, Math.min(1, channels[i][pos]));
            sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767)|0;
            view.setInt16(44 + offset, sample, true); 
            offset += 2;
        }
        pos++;
    }

    return new Blob([buffer], {type: "audio/wav"});

    function setUint16(data) {
        view.setUint16(pos, data, true);
        pos += 2;
    }
    function setUint32(data) {
        view.setUint32(pos, data, true);
        pos += 4;
    }
}
