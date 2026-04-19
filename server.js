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
  user: { password: "1234", role: "public" }
};

// ===== SESSION (simple) =====
let currentRole = null;

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
  const { username, password } = req.body;

  if (USERS[username] && USERS[username].password === password) {
    currentRole = USERS[username].role;
    res.json({ success: true, role: currentRole });
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

// ===== DELETE NODE (ADMIN ONLY) =====
app.get('/delete/:node', async (req, res) => {
  if (currentRole !== "admin") return res.send("Unauthorized");

  const node = req.params.node;

  await Data.deleteMany({ node: node });
  delete latestData[node];

  res.send("Node deleted");
});

// ===== RESET ALL =====
app.get('/reset', async (req, res) => {
  if (currentRole !== "admin") return res.send("Unauthorized");

  await Data.deleteMany({});
  latestData = {};

  res.send("Database cleared");
});

// ===== CSV =====
app.get('/download', async (req, res) => {
  if (currentRole !== "admin") return res.send("Unauthorized");

  const data = await Data.find().sort({ time: 1 });

  const formatted = data.map(d => ({
    Time: new Date(d.time).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata"
    }),
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

table {
  margin: auto;
  border-collapse: collapse;
  width: 80%;
}

th, td {
  border: 1px solid white;
  padding: 10px;
}

th {
  background: #22c55e;
}

button {
  padding: 6px 10px;
  margin: 5px;
  border: none;
  background: #22c55e;
  color: white;
  cursor: pointer;
}
</style>

</head>

<body>

<div id="loginBox">
  <h2>Login</h2>
  <input id="u" placeholder="Username"><br>
  <input id="p" type="password" placeholder="Password"><br>
  <button onclick="login()">Login</button>
</div>

<div id="dash" style="display:none;">
  <h1>🌍 Pollution Dashboard</h1>

  <div id="adminControls" style="display:none;">
    <button onclick="download()">📥 Download CSV</button>
    <button onclick="reset()">🗑 Reset All</button>
  </div>

  <table>
    <thead>
      <tr>
        <th>Node</th>
        <th>Temp</th>
        <th>Humidity</th>
        <th>Gas</th>
        <th>Time</th>
        <th id="actionHead">Action</th>
      </tr>
    </thead>
    <tbody id="data"></tbody>
  </table>
</div>

<script>

let role = "";

async function login(){
  let res = await fetch('/login',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:u.value,password:p.value})
  });

  let d = await res.json();

  if(d.success){
    role = d.role;

    loginBox.style.display='none';
    dash.style.display='block';

    if(role === "admin"){
      adminControls.style.display='block';
    } else {
      actionHead.style.display='none';
    }

    loadData();
  } else {
    alert("Wrong login");
  }
}

async function loadData(){
  let res = await fetch('/api/data');
  let data = await res.json();

  let html = "";

  for(let node in data){
    let d = data[node];

    html += \`
    <tr>
      <td>\${d.node}</td>
      <td>\${d.temp}</td>
      <td>\${d.hum}</td>
      <td>\${d.gas}</td>
      <td>\${new Date(d.time).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}</td>
      \${role==="admin" ? \`<td><button onclick="del('\${d.node}')">Clear</button></td>\` : ""}
    </tr>
    \`;
  }

  document.getElementById("data").innerHTML = html;

  setTimeout(loadData, 3000);
}

function download(){
  window.location='/download';
}

function reset(){
  fetch('/reset').then(()=>alert("All Data Cleared"));
}

function del(node){
  fetch('/delete/'+node).then(()=>alert(node+" cleared"));
}

</script>

</body>
</html>
`);
});

// ===== START =====
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
