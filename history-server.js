const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 8081;

app.use(cors());

// CONFIGURATION
const SAVE_INTERVAL = 5 * 60 * 1000;
const DATA_DIR = path.join(__dirname, 'recordings');
const MAX_HISTORY = 10000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Generate Filename (Only used if recording)
const getTurkeyTime = () => {
    return new Date().toLocaleString('sv-SE', {
        timeZone: 'Europe/Istanbul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).replace(' ', '_').replace(/:/g, '-');
};

const sessionName = `Run_${getTurkeyTime()}.json`;
const sessionPath = path.join(DATA_DIR, sessionName);

// STATE
let history = {};
let topicTypes = {};
let isRecording = false; // <--- NEW SAFETY FLAG

// ROS CONNECTION
const ROS_URL = 'ws://localhost:9090';
let rosSocket;

function connectToRos() {
    rosSocket = new WebSocket(ROS_URL);

    rosSocket.on('open', () => {
        console.log('✅ Connected to ROS Bridge');
        requestTopics();
    });

    rosSocket.on('message', (data) => {
        const message = JSON.parse(data);

        if (message.op === 'service_response' && message.service === '/rosapi/topics') {
            const IGNORED_TYPES = [
                'sensor_msgs/Image', 'sensor_msgs/msg/Image',
                'sensor_msgs/CompressedImage', 'sensor_msgs/msg/CompressedImage',
                'sensor_msgs/PointCloud2', 'sensor_msgs/msg/PointCloud2',
                'sensor_msgs/LaserScan', 'sensor_msgs/msg/LaserScan',
                'nav_msgs/OccupancyGrid', 'nav_msgs/msg/OccupancyGrid',
                'tf2_msgs/TFMessage', 'tf2_msgs/msg/TFMessage'
            ];
            
            let filteredTopics = [];
            let filteredTypes = [];
            
            for (let i = 0; i < message.values.topics.length; i++) {
                if (!IGNORED_TYPES.includes(message.values.types[i])) {
                    filteredTopics.push(message.values.topics[i]);
                    filteredTypes.push(message.values.types[i]);
                }
            }
            subscribeToNewTopics(filteredTopics, filteredTypes);
        }

        if (message.op === 'publish') {
            const topic = message.topic;
            const msg = message.msg;

            // Extract the first numeric value found in complex messages
            function extractNumericValue(obj) {
                if (typeof obj === 'number') return obj;
                if (typeof obj === 'object' && obj !== null) {
                    for (let key in obj) {
                        let result = extractNumericValue(obj[key]);
                        if (result !== undefined) return result;
                    }
                }
                return undefined;
            }

            let val = extractNumericValue(msg);

            if (!history[topic]) history[topic] = [];
            
            history[topic].push({
                timestamp: Date.now(),
                value: val
            });

            if (history[topic].length > MAX_HISTORY) {
                history[topic].shift();
            }
        }
    });

    rosSocket.on('error', (err) => console.log('❌ ROS Socket Error:', err.message));
    rosSocket.on('close', () => setTimeout(connectToRos, 2000));
}

function requestTopics() {
    if (rosSocket && rosSocket.readyState === WebSocket.OPEN) {
        rosSocket.send(JSON.stringify({
            op: 'call_service',
            service: '/rosapi/topics',
            id: 'topic-scan'
        }));
    }
}

function subscribeToNewTopics(topics, types) {
    topics.forEach((topic, index) => {
        if (!topicTypes[topic]) topicTypes[topic] = types[index];

        if (!history[topic]) {
            history[topic] = [];
            if (rosSocket.readyState === WebSocket.OPEN) {
                rosSocket.send(JSON.stringify({
                    op: 'subscribe',
                    topic: topic,
                    type: types[index]
                }));
            }
        }
    });
}

// --- SAVING ---

function saveHistory() {
    // SECURITY CHECK: Never save if we are in playback mode
    if (!isRecording) return; 

    const dump = {
        types: topicTypes,
        data: history
    };
    const dataStr = JSON.stringify(dump, null, 2);
    fs.writeFileSync(sessionPath, dataStr);
    console.log(`\n💾 Session saved: ${sessionName}`);
}

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    // Only save on exit if we were actually recording
    if (isRecording) {
        saveHistory();
    } else {
        console.log("🚫 Playback mode: No changes saved.");
    }
    process.exit();
});

// --- STARTUP LOGIC ---

const args = process.argv.slice(2);

// PLAYBACK MODE
if (args[0] === 'playback' && args[1]) {
    const loadPath = path.join(DATA_DIR, args[1]);
    if (fs.existsSync(loadPath)) {
        console.log(`📂 PLAYBACK MODE: Loading ${args[1]}`);
        console.log(`🔒 Read-Only: Saving is DISABLED.`);
        
        const rawData = JSON.parse(fs.readFileSync(loadPath));
        if (rawData.types) {
            topicTypes = rawData.types;
            history = rawData.data;
        } else {
            history = rawData;
            topicTypes = {};
        }
        
        console.log(`✅ Loaded ${Object.keys(history).length} topics.`);
        isRecording = false; // Ensure flag is off
    } else {
        console.error(`❌ File not found: ${loadPath}`);
        process.exit(1);
    }

// RECORDING MODE
} else {
    console.log(`🔴 RECORDING MODE.`);
    console.log(`💾 Saving to ${sessionName}`);
    
    isRecording = true; // Enable saving
    connectToRos();
    
    // Only start the auto-save timer if we are recording
    setInterval(requestTopics, 5000);
    setInterval(saveHistory, SAVE_INTERVAL);
}


// --- API ---

app.get('/topics', (req, res) => {
    const topics = Object.keys(history);
    const types = topics.map(t => topicTypes[t] || 'unknown');
    res.json({ topics, types });
});

app.get('/history/:topic', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    
    const topicParam = req.params.topic;
    const topicName = '/' + topicParam.replace(/:/g, '/');
    
    const start = parseInt(req.query.start) || 0;
    const end = parseInt(req.query.end) || Date.now();

    if (history[topicName]) {
        const data = history[topicName].filter(p => p.timestamp >= start && p.timestamp <= end);
        res.json(data);
    } else {
        res.json([]);
    }
});

app.listen(port, () => {
    console.log(`🚀 History Server running on http://localhost:${port}`);
});
