const express = require('express');
const mqtt = require('mqtt');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const { Parser } = require('json2csv');
const webpush = require('web-push');

const app = express();
app.use(bodyParser.json());

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

    if (!buffer[node]) buffer[node] = [];
    buffer[node].push(data);

    buffer[node] = buffer[node].filter(d =>
      (Date.now() - new Date(d.time)) < 60000
    );

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

      // ===== NOTIFICATION =====
      if ((Date.now() - lastAlertTime > 300000) && avgData.temp > 30) {

        lastAlertTime = Date.now();

        const payload = JSON.stringify({
          title: "🔥 Temperature Alert",
          body: `${node}: ${avgData.temp}°C`
        });

        const subs = await Subscriber.find();

        subs.forEach(sub => {
          webpush.sendNotification(sub, payload)
          .catch(err => console.log(err.message));
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

// ===== UI =====
app.get('/', (req, res) => {
res.send(`
<!DOCTYPE html>
<html>
<head>
<title>IoT Dashboard</title>

<style>
body { font-family: Arial; background:#0f172a; color:white; text-align:center; }
button { padding:10px; margin:10px; background:#22c55e; border:none; color:white; cursor:pointer; }

.container { display:flex; flex-wrap:wrap; justify-content:center; gap:20px; }

.card {
  background:#1e293b;
  padding:20px;
  border-radius:15px;
  width:250px;
}

.circle {
  width:120px;
  height:120px;
  border-radius:50%;
  background:conic-gradient(#22c55e 0deg, #22c55e var(--deg), #334155 var(--deg));
  display:flex;
  align-items:center;
  justify-content:center;
  margin:auto;
}

.inner {
  width:90px;
  height:90px;
  border-radius:50%;
  background:#0f172a;
  display:flex;
  align-items:center;
  justify-content:center;
}

.weather { font-size:40px; }

table {
  margin:auto;
  width:80%;
  border-collapse:collapse;
}

th, td {
  border:1px solid white;
  padding:10px;
}
</style>
</head>

<body>

<h1>🌍 IoT Dashboard</h1>
<button onclick="enableNotifications()">🔔 Enable Alerts</button>

<div id="roleSelect">
  <button onclick="selectRole('admin')">👑 Admin</button>
  <button onclick="selectRole('user')">👤 User</button>
</div>

<div id="loginBox" style="display:none;">
  <h2 id="roleTitle"></h2>
  <input id="u" placeholder="Username"><br>
  <input id="p" type="password" placeholder="Password"><br>
  <button onclick="login()">Login</button>
</div>

<div id="userUI" style="display:none;">
  <h2>User Dashboard</h2>
  <div class="container" id="cards"></div>
</div>

<div id="adminUI" style="display:none;">
  <h2>Admin Dashboard</h2>
  <button onclick="download()">Download CSV</button>
  <button onclick="reset()">Reset DB</button>

  <table>
    <thead>
      <tr>
        <th>Node</th>
        <th>Temp</th>
        <th>Hum</th>
        <th>Gas</th>
        <th>Time</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody id="table"></tbody>
  </table>
</div>

<script>

const ALL_NODES = ["node1","node2","node3"];
const publicKey = "${PUBLIC_KEY}";

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

async function enableNotifications(){
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return alert("Permission denied");

  const sw = await navigator.serviceWorker.register('/sw.js');
  const sub = await sw.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });

  await fetch('/subscribe-notification',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(sub)
  });

  alert("✅ Notifications Enabled");
}

let selectedRole="";

function selectRole(role){
  selectedRole=role;
  roleSelect.style.display="none";
  loginBox.style.display="block";
  roleTitle.innerText=role.toUpperCase()+" LOGIN";
}

async function login(){
  let res=await fetch('/login',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:u.value,password:p.value,role:selectedRole})
  });

  let d=await res.json();

  if(d.success){
    loginBox.style.display='none';

    if(selectedRole==="admin"){
      adminUI.style.display="block";
      loadAdmin();
    } else {
      userUI.style.display="block";
      loadUser();
    }
  } else alert("Wrong credentials");
}

function getWeather(t){
  if(t>35) return "☀️";
  if(t>25) return "⛅";
  if(t>15) return "☁️";
  return "🌧";
}

async function loadUser(){
  let res = await fetch('/api/data');
  let data = await res.json();

  let html = "";

  ALL_NODES.forEach(n=>{
    if(data[n]){
      let d=data[n];
      let deg=(d.temp/50)*360;

      html+=\`
      <div class="card">
        <h3>\${d.node}</h3>
        <div class="weather">\${getWeather(d.temp)}</div>
        <div class="circle" style="--deg:\${deg}deg">
          <div class="inner">\${d.temp}°C</div>
        </div>
        <p>💧 \${d.hum}%</p>
        <p>💨 \${d.gas}</p>
      </div>\`;
    } else {
      html+=\`
      <div class="card">
        <h3>\${n}</h3>
        <div style="color:orange;">
          ⚠️ Node under repair<br>
          Service available soon
        </div>
      </div>\`;
    }
  });

  cards.innerHTML=html;
  setTimeout(loadUser,2000);
}

async function loadAdmin(){
  let res = await fetch('/api/data');
  let data = await res.json();

  let html="";

  ALL_NODES.forEach(n=>{
    if(data[n]){
      let d=data[n];

      html+=\`
      <tr>
        <td>\${d.node}</td>
        <td>\${d.temp}</td>
        <td>\${d.hum}</td>
        <td>\${d.gas}</td>
        <td>\${new Date(d.time).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}</td>
        <td><button onclick="del('\${d.node}')">Clear</button></td>
      </tr>\`;
    } else {
      html+=\`
      <tr>
        <td>\${n}</td>
        <td colspan="4" style="color:orange;">⚠️ Node under repair</td>
        <td>-</td>
      </tr>\`;
    }
  });

  table.innerHTML=html;
  setTimeout(loadAdmin,3000);
}

function reset(){ fetch('/reset'); }
function del(n){ fetch('/delete/'+n); }
function download(){ window.location='/download'; }

</script>

</body>
</html>
`);
});

// ===== START =====
app.listen(PORT, () => {
  console.log("🚀 Running on port", PORT);
});
