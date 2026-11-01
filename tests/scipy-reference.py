"""Optional independent reference check; requires NumPy and SciPy, not used by the site."""
import json
import subprocess
from pathlib import Path
import numpy as np
from scipy.signal import iirnotch, lfilter, lfilter_zi

root = Path(__file__).resolve().parents[1]
result = subprocess.run([
    'node', '-e', '''const {Notch}=require('./ecg-core.js');const f=new Notch();
    const x=Array.from({length:2000},(_,i)=>2000+100*Math.sin(2*Math.PI*10*i/250)+100*Math.sin(2*Math.PI*60*i/250));
    console.log(JSON.stringify({b:[f.b0,f.b1,f.b2],a:[1,f.a1,f.a2],x,y:x.map(v=>f.next(v))}));'''
], cwd=root, capture_output=True, text=True, check=True)
data = json.loads(result.stdout)
b, a = iirnotch(60, 30, fs=250)
np.testing.assert_allclose(data['b'], b, rtol=0, atol=1e-14)
np.testing.assert_allclose(data['a'], a, rtol=0, atol=1e-14)
y, _ = lfilter(b, a, data['x'], zi=lfilter_zi(b, a)*data['x'][0])
np.testing.assert_allclose(data['y'], y, rtol=0, atol=1e-9)
print(f'PASS: scipy.signal.iirnotch coefficients and lfilter output; max error {np.max(np.abs(y-data["y"])):.3g} ADC')

# Monitoring band: JS MonitorFilter == scipy butter(2) HP 0.5 -> iirnotch 60 -> butter(2) LP 40,
# each stage started from its constant-input steady state.
from scipy.signal import butter
result = subprocess.run([
    'node', '-e', '''const {MonitorFilter}=require('./ecg-core.js');const f=new MonitorFilter();
    const x=Array.from({length:3000},(_,i)=>2000+300*Math.sin(2*Math.PI*1.2*i/250)+80*Math.sin(2*Math.PI*60*i/250)+40*Math.sin(2*Math.PI*0.2*i/250));
    console.log(JSON.stringify({x,y:x.map(v=>f.next(v))}));'''
], cwd=root, capture_output=True, text=True, check=True)
data = json.loads(result.stdout)
stages = [butter(2, 0.5, 'highpass', fs=250), iirnotch(60, 30, fs=250), butter(2, 40, 'lowpass', fs=250)]
v = np.asarray(data['x'])
for b, a in stages:
    v, _ = lfilter(b, a, v, zi=lfilter_zi(b, a) * v[0])
np.testing.assert_allclose(data['y'], v, rtol=0, atol=1e-8)
print(f'PASS: monitor chain matches scipy butter/iirnotch cascade; max error {np.max(np.abs(v-data["y"])):.3g} ADC')
