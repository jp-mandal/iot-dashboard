const express = require('express');
const mqtt = require('mqtt');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const { Parser } = require('json2csv');
const webpush = require('web-push');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ===== VAPID KEYS =====
const PUBLIC_KEY = "BAV36BWFZHKSJhaSxWvPeFODkdGTG5kZjn6uOZQtM0wrvcvLy4WRnNVwIJRYtMrCVAWrmx_4uF5We8G-YmX9rmU";
const PRIVATE_KEY = "uOnrKBHB14vMBN7zPFqmi4XCQv4C2ZG2SGmzXHRcdvA";

webpush.setVapidDetails(
  "mailto:jpmandal123456@gmail.com",
  PUBLIC_KEY,
  PRIVATE_KEY
);

// ===== USERS =====
const USERS = {
  admin: { password: "1234", role: "admin" },
  user: { password: "1234", role: "user" }
};

let currentRole = "";

// ===== MONGODB =====
mongoose.connect(process.env.MONGO_URL)
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.log(err));

// ===== MODELS =====
const Data = mongoose.model("Data", {
  node: String,
  temp: Number,
  hum: Number,
  gas: Number,
  time: { type: Date, default: Date.now }
});

const Subscriber = mongoose.model("Subscriber", {
  endpoint: String,
  keys: Object
});

// ===== MEMORY =====
let latestData = {};
let buffer = {};
let lastStoredTime = {};
let lastAlertTime = 0;

// ===== MQTT =====
const client = mqtt.connect('mqtts://7564b99907f74747bac93aa42ec8f77b.s1.eu.hivemq.cloud', {
  username: 'climate',
  password: 'Climate@2',
  reconnectPeriod: 2000
});

client.on('connect', () => {
  console.log("✅ MQTT Connected");
  client.subscribe("pollution/#");
});

// ===== MAIN LOGIC =====
client.on('message', async (topic, message) => {
  try {
    let text = message.toString();
    if (!text.startsWith("{")) return;

    const data = JSON.parse(text);
    data.time = new Date();

    const node = data.node;

    // ===== BUFFER =====
    if (!buffer[node]) buffer[node] = [];
    buffer[node].push(data);

    // keep only last 1 min
    buffer[node] = buffer[node].filter(d =>
      (Date.now() - new Date(d.time)) < 60000
    );

    // ===== STORE AVG EVERY 1 MIN =====
    if (!lastStoredTime[node] || (Date.now() - lastStoredTime[node] > 60000)) {

      const arr = buffer[node];
      if (arr.length === 0) return;

      const avgTemp = arr.reduce((s,d)=>s+d.temp,0)/arr.length;
      const avgHum  = arr.reduce((s,d)=>s+d.hum,0)/arr.length;
      const avgGas  = arr.reduce((s,d)=>s+d.gas,0)/arr.length;

      const avgData = {
        node,
        temp: Number(avgTemp.toFixed(2)),
        hum: Number(avgHum.toFixed(2)),
        gas: Math.round(avgGas),
        time: new Date()
      };

      latestData[node] = avgData;
      await Data.create(avgData);

      lastStoredTime[node] = Date.now();

      console.log("📊 AVG STORED:", avgData);

      // ===== NOTIFICATION (5 MIN) =====
      if ((Date.now() - lastAlertTime > 300000) && avgData.temp > 30) {

        lastAlertTime = Date.now();

        const payload = JSON.stringify({
          title: "🔥 Temperature Alert",
          body: `${node}: ${avgData.temp}°C`
        });

        const subs = await Subscriber.find();

        subs.forEach(sub => {
          webpush.sendNotification(sub, payload)
          .catch(err => console.log("Push error:", err.message));
        });
      }
    }

  } catch (err) {
    console.log(err.message);
  }
});

// ===== SUBSCRIBE =====
app.post('/subscribe-notification', async (req, res) => {
  const sub = req.body;

  const exists = await Subscriber.findOne({ endpoint: sub.endpoint });
  if (!exists) await Subscriber.create(sub);

  res.sendStatus(201);
});

// ===== LOGIN =====
app.post('/login', (req, res) => {
  const { username, password, role } = req.body;

  if (USERS[username] &&
      USERS[username].password === password &&
      USERS[username].role === role) {

    currentRole = role;
    res.json({ success: true });

  } else res.json({ success: false });
});

// ===== API =====
app.get('/api/data', (req, res) => {
  const now = new Date();
  let filtered = {};

  for (let node in latestData) {
    let d = latestData[node];
    if ((now - new Date(d.time)) < 120000) {
      filtered[node] = d;
    }
  }

  res.json(filtered);
});

// ===== ADMIN =====
app.get('/reset', async (req, res) => {
  if (currentRole !== "admin") return res.send("Unauthorized");

  await Data.deleteMany({});
  latestData = {};

  res.send("Database Cleared");
});

app.get('/delete/:node', async (req, res) => {
  if (currentRole !== "admin") return res.send("Unauthorized");

  const node = req.params.node;

  await Data.deleteMany({ node });
  delete latestData[node];

  res.send("Node Deleted");
});

// ===== CSV =====
app.get('/download', async (req, res) => {
  if (currentRole !== "admin") return res.send("Unauthorized");

  const data = await Data.find().sort({ time: 1 });

  let rows = {};

  data.forEach(d => {
    let time = new Date(d.time).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata"
    });

    if (!rows[time]) rows[time] = { Time: time };

    rows[time][`${d.node}_Temp`] = d.temp;
    rows[time][`${d.node}_Hum`] = d.hum;
    rows[time][`${d.node}_Gas`] = d.gas;
  });

  const parser = new Parser();
  const csv = parser.parse(Object.values(rows));

  res.header('Content-Type', 'text/csv');
  res.attachment('iot_data.csv');
  res.send(csv);
});

// ===== UI (UNCHANGED) =====
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// ===== START =====
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
