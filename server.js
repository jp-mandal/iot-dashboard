const express = require('express');
const mqtt = require('mqtt');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const { Parser } = require('json2csv');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

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

  } catch (err) {
    console.log(err.message);
  }
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

// ===== ADMIN APIs =====
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

app.get('/download', async (req, res) => {
  if (currentRole !== "admin") return res.send("Unauthorized");

  const data = await Data.find().sort({ time: 1 });

  const formatted = data.map(d => ({
    Time: new Date(d.time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    Node: d.node,
    Temperature: d.temp,
    Humidity: d.hum,
    Gas: d.gas
  }));

  const parser = new Parser();
  const csv = parser.parse(formatted);

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
body {
  font-family: Arial;
  background: #0f172a;
  color: white;
  text-align: center;
}

button {
  padding: 10px;
  margin: 10px;
  background: #22c55e;
  border: none;
  color: white;
  cursor: pointer;
}

.container {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 20px;
}

.card {
  background: #1e293b;
  padding: 20px;
  border-radius: 15px;
  width: 250px;
}

.circle {
  width: 120px;
  height: 120px;
  border-radius: 50%;
  background: conic-gradient(#22c55e 0deg, #22c55e var(--deg), #334155 var(--deg));
  display: flex;
  align-items: center;
  justify-content: center;
  margin: auto;
}

.inner {
  width: 90px;
  height: 90px;
  border-radius: 50%;
  background: #0f172a;
  display: flex;
  align-items: center;
  justify-content: center;
}

.weather {
  font-size: 40px;
}

table {
  margin: auto;
  width: 80%;
  border-collapse: collapse;
}

th, td {
  border: 1px solid white;
  padding: 10px;
}
</style>
</head>

<body>

<h1>🌍 IoT Dashboard</h1>

<!-- ROLE SELECT -->
<div id="roleSelect">
  <button onclick="selectRole('admin')">👑 Admin</button>
  <button onclick="selectRole('user')">👤 User</button>
</div>

<!-- LOGIN -->
<div id="loginBox" style="display:none;">
  <h2 id="roleTitle"></h2>
  <input id="u" placeholder="Username"><br>
  <input id="p" type="password" placeholder="Password"><br>
  <button onclick="login()">Login</button>
</div>

<!-- USER UI -->
<div id="userUI" style="display:none;">
  <h2>User Dashboard</h2>
  <div class="container" id="cards"></div>
</div>

<!-- ADMIN UI -->
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

let selectedRole = "";

function selectRole(role){
  selectedRole = role;
  roleSelect.style.display="none";
  loginBox.style.display="block";
  roleTitle.innerText = role.toUpperCase() + " LOGIN";
}

async function login(){
  let res = await fetch('/login',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      username: u.value,
      password: p.value,
      role: selectedRole
    })
  });

  let d = await res.json();

  if(d.success){
    loginBox.style.display='none';

    if(selectedRole==="admin"){
      adminUI.style.display="block";
      loadAdmin();
    } else {
      userUI.style.display="block";
      loadUser();
    }

  } else {
    alert("Wrong credentials");
  }
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

  let html="";
  for(let n in data){
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
  }

  cards.innerHTML=html;
  setTimeout(loadUser,2000);
}

async function loadAdmin(){
  let res = await fetch('/api/data');
  let data = await res.json();

  let html="";
  for(let n in data){
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
  }

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
