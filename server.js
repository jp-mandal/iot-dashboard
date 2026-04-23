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

let subscribers = [];

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

// ===== MODEL =====
const Data = mongoose.model("Data", {
  node: String,
  temp: Number,
  hum: Number,
  gas: Number,
  time: { type: Date, default: Date.now }
});

// ===== STORE =====
let latestData = {};
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

client.on('message', async (topic, message) => {
  try {
    let text = message.toString();
    if (!text.startsWith("{")) return;

    const data = JSON.parse(text);
    data.time = new Date();

    latestData[data.node] = data;
    await Data.create(data);

    // ===== ALERT (TEMP > 30°C) =====
    if ((Date.now() - lastAlertTime > 60000) && data.temp > 30) {

      lastAlertTime = Date.now();

      const payload = JSON.stringify({
        title: "🔥 Temperature Alert!",
        body: `${data.node} → ${data.temp}°C`
      });

      subscribers.forEach(sub => {
        webpush.sendNotification(sub, payload)
        .catch(err => console.log("Push error:", err.message));
      });
    }

  } catch (err) {
    console.log(err.message);
  }
});

// ===== SUBSCRIBE =====
app.post('/subscribe-notification', (req, res) => {
  subscribers.push(req.body);
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

  } else {
    res.json({ success: false });
  }
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
  res.send("Cleared");
});

app.get('/delete/:node', async (req, res) => {
  if (currentRole !== "admin") return res.send("Unauthorized");

  let node = req.params.node;
  await Data.deleteMany({ node });
  delete latestData[node];

  res.send("Deleted");
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

// ===== UI =====
app.get('/', (req, res) => {
res.send(`
<!DOCTYPE html>
<html>
<head>
<title>IoT Dashboard</title>
<link rel="manifest" href="/manifest.json">
</head>

<body style="background:#0f172a;color:white;text-align:center;">

<h1>🌍 IoT Dashboard</h1>

<button onclick="enableNotifications()">🔔 Enable Alerts</button>

<script>
async function enableNotifications(){
  const permission = await Notification.requestPermission();
  if(permission!=="granted"){ alert("Denied"); return; }

  const reg = await navigator.serviceWorker.register('/sw.js');

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly:true,
    applicationServerKey:"${PUBLIC_KEY}"
  });

  await fetch('/subscribe-notification',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(sub)
  });

  alert("Notifications Enabled");
}
</script>

</body>
</html>
`);
});

// ===== START =====
app.listen(PORT, () => {
  console.log("🚀 Running on port", PORT);
});
