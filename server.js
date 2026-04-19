const express = require('express');
const mqtt = require('mqtt');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const { Parser } = require('json2csv');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ===== LOGIN =====
const USER = { username: "admin", password: "1234" };

// ===== MONGODB =====
mongoose.connect(process.env.MONGO_URL)
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.log("❌ MongoDB Error:", err));

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

// ===== MQTT (FIXED & STABLE) =====
const client = mqtt.connect('mqtts://7564b99907f74747bac93aa42ec8f77b.s1.eu.hivemq.cloud', {
  username: 'climate',
  password: 'Climate@2',
  reconnectPeriod: 2000,
  connectTimeout: 5000
});

client.on('connect', () => {
  console.log("✅ MQTT Connected");
  client.subscribe("pollution/#");
});

client.on('error', (err) => {
  console.log("❌ MQTT Error:", err.message);
});

client.on('message', async (topic, message) => {
  try {
    let text = message.toString();

    console.log("📩 RAW:", text); // DEBUG

    if (!text.startsWith("{")) return;

    const data = JSON.parse(text);

    latestData[data.node] = data;

    await Data.create(data);

    console.log("📥 Saved:", data);

  } catch (err) {
    console.log("❌ Parse Error:", err.message);
  }
});

// ===== LOGIN =====
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  res.json({ success: username === USER.username && password === USER.password });
});

// ===== API =====
app.get('/api/data', (req, res) => {
  res.json(latestData);
});

// ===== CSV (INDIA TIME FIXED) =====
app.get('/download', async (req, res) => {
  try {
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

    const parser = new Parser({
      fields: ["Time", "Node", "Temperature", "Humidity", "Gas"]
    });

    const csv = parser.parse(formatted);

    res.header('Content-Type', 'text/csv');
    res.attachment('iot_data.csv');
    res.send(csv);

  } catch (err) {
    res.status(500).send("Error generating CSV");
  }
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
  margin: 0;
  font-family: Arial;
  background: #0f172a;
  color: white;
}

.login {
  text-align: center;
  margin-top: 100px;
}

input {
  padding: 10px;
  margin: 10px;
  border-radius: 5px;
  border: none;
}

button {
  padding: 10px 20px;
  background: #22c55e;
  border: none;
  color: white;
  border-radius: 5px;
  cursor: pointer;
}

.dashboard {
  display: none;
  padding: 20px;
}

.container {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
  justify-content: center;
}

.card {
  background: #1e293b;
  padding: 20px;
  border-radius: 15px;
  width: 260px;
  text-align: center;
  box-shadow: 0 0 10px black;
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
  font-size: 20px;
}

.weather {
  font-size: 40px;
  margin: 10px;
}

.download {
  text-align: center;
  margin-top: 40px;
}
</style>

</head>

<body>

<div class="login" id="loginBox">
  <h2>Login</h2>
  <input id="u" placeholder="Username"><br>
  <input id="p" type="password" placeholder="Password"><br>
  <button onclick="login()">Login</button>
</div>

<div class="dashboard" id="dash">
  <h1 style="text-align:center;">🌍 Pollution Dashboard</h1>

  <div class="container" id="data"></div>

  <div class="download">
    <button onclick="download()">📥 Download CSV</button>
  </div>
</div>

<script>

function getWeather(temp){
  if(temp > 35) return "☀️";
  if(temp > 25) return "⛅";
  if(temp > 15) return "☁️";
  return "🌧";
}

async function login(){
  let res = await fetch('/login',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:u.value,password:p.value})
  });

  let d = await res.json();

  if(d.success){
    loginBox.style.display='none';
    dash.style.display='block';
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
    let deg = (d.temp / 50) * 360;

    html += \`
    <div class="card">
      <h2>\${d.node}</h2>

      <div class="weather">\${getWeather(d.temp)}</div>

      <div class="circle" style="--deg:\${deg}deg">
        <div class="inner">\${d.temp}°C</div>
      </div>

      <p>💧 Humidity: \${d.hum}%</p>
      <p>💨 Gas: \${d.gas}</p>
      <p>🕒 \${new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}</p>

      \${d.gas > 2000 ? "<p style='color:red;'>⚠ Gas Alert</p>" : ""}
    </div>
    \`;
  }

  document.getElementById("data").innerHTML = html;

  setTimeout(loadData, 2000);
}

function download(){
  window.location = '/download';
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
