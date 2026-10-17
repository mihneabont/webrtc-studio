"""End-to-end check of a running mixer: pairing, control, SRT and RTMP sources, an RTMP output.

Run a mixer first (python -m studio_mixer --data DIR), then:
    python tests/api_check.py --data DIR
Needs ffmpeg on PATH. Prints one line per check and exits non-zero on failure.
"""
import argparse, asyncio, json, subprocess, sys, time
from pathlib import Path
import aiohttp

ap = argparse.ArgumentParser()
ap.add_argument('--data', type=Path, required=True)
ap.add_argument('--base', default='http://127.0.0.1:8788')
ap.add_argument('--out', type=Path, default=Path('.'))
args = ap.parse_args()
store = json.loads((args.data / 'mixer.json').read_text())
fails = 0

def check(name, ok, detail=''):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name + (f'  ({detail})' if detail else ''), flush=True)
    fails += 0 if ok else 1

def ffpub(argv):
    return subprocess.Popen(['ffmpeg', '-nostdin', '-loglevel', 'error', '-re', *argv], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

async def main():
    async with aiohttp.ClientSession() as s:
        r = await s.post(f'{args.base}/api/pair', json={'code': '000000'})
        check('wrong pairing code refused', r.status == 403, r.status)
        r = await s.post(f'{args.base}/api/pair', json={'code': store['pair_code'], 'name': 'api-check'})
        check('pairing with the code', r.status == 200, r.status)
        token = (await r.json())['token']
        r = await s.get(f'{args.base}/api/status')
        check('status needs a token', r.status == 401, r.status)
        ws = await s.ws_connect(f'{args.base}/api/control?token={token}')
        hello = json.loads((await ws.receive()).data)
        check('control socket says hello', hello.get('t') == 'hello' and hello.get('app') == 'studio-mixer')
        sources = [{'id': 'a', 'name': 'SRT cam', 'kind': 'srt', 'token': 'tok-a'},
                   {'id': 'b', 'name': 'RTMP cam', 'kind': 'rtmp', 'token': 'tok-b'},
                   {'id': 'c', 'name': 'Loopback', 'kind': 'rtmp', 'token': 'tok-c'}]
        scenes = {'sa': {'id': 'sa', 'layers': [{'t': 'video', 'src': 'a', 'x': 0, 'y': 0, 'w': 1, 'h': 1, 'fit': 'cover'}]},
                  'sb': {'id': 'sb', 'layers': [{'t': 'video', 'src': 'b', 'x': 0, 'y': 0, 'w': 1, 'h': 1, 'fit': 'cover'}]}}
        outputs = [{'id': 'o1', 'kind': 'rtmp', 'name': 'loop', 'url': 'rtmp://127.0.0.1:8794/in', 'key': 'c?user=src&pass=tok-c'}]
        await ws.send_json({'t': 'hello', 'ws': {'format': {'width': 1280, 'height': 720, 'fps': 30}, 'sources': sources,
                                                  'scenes': scenes, 'outputs': outputs, 'transition': {'type': 'mix', 'duration': 500},
                                                  'shots': {'preview': 'sb', 'programme': 'sa'}}})
        bad = ffpub(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast',
                     '-f', 'mpegts', 'srt://127.0.0.1:8793?streamid=publish:in/a:src:wrong'])
        pa = ffpub(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=f=440', '-c:v', 'libx264',
                    '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-c:a', 'aac', '-f', 'mpegts',
                    'srt://127.0.0.1:8793?streamid=publish:in/a:src:tok-a'])
        pb = ffpub(['-f', 'lavfi', '-i', 'smptebars=size=1280x720:rate=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune',
                    'zerolatency', '-g', '30', '-f', 'flv', 'rtmp://127.0.0.1:8794/in/b?user=src&pass=tok-b'])
        status = {}
        deadline = time.time() + 25
        while time.time() < deadline:
            msg = await ws.receive(timeout=5)
            d = json.loads(msg.data)
            if d.get('t') == 'status':
                status = d
                st = {k: v.get('state') for k, v in (d.get('sources') or {}).items()}
                if st.get('a') == 'connected' and st.get('b') == 'connected' and d.get('programme') == 'sa':
                    break
        st = {k: v.get('state') for k, v in (status.get('sources') or {}).items()}
        check('SRT source with its token connects', st.get('a') == 'connected', st)
        check('RTMP source with its token connects', st.get('b') == 'connected', st)
        check('programme and preview adopted from the page', status.get('programme') == 'sa' and status.get('preview') == 'sb',
              (status.get('programme'), status.get('preview')))
        check('ingest stats reported', (status.get('sources', {}).get('a', {}).get('ingest') or {}).get('protocol') == 'SRT')
        await ws.send_json({'t': 'auto'})
        await asyncio.sleep(1.5)
        r = await s.get(f'{args.base}/api/status', headers={'Authorization': f'Bearer {token}'})
        d = await r.json()
        check('auto transition takes preview to programme', d.get('programme') == 'sb' and d.get('preview') == 'sa',
              (d.get('programme'), d.get('preview')))
        await ws.send_json({'t': 'output', 'action': 'start', 'id': 'o1'})
        deadline, ostate = time.time() + 20, None
        while time.time() < deadline:
            d = json.loads((await ws.receive(timeout=5)).data)
            if d.get('t') == 'status':
                ostate = (d.get('outputs') or {}).get('o1', {})
                cst = (d.get('sources') or {}).get('c', {}).get('state')
                if ostate.get('state') == 'live' and cst == 'connected':
                    break
        check('RTMP output goes live', (ostate or {}).get('state') == 'live', ostate)
        check('output arrives back as a source (loopback)', cst == 'connected', cst)
        rtsp = f"rtsp://engine:{store['engine_secret']}@127.0.0.1:8790/multiview"
        out = args.out / 'multiview.png'
        subprocess.run(['ffmpeg', '-loglevel', 'quiet', '-y', '-rtsp_transport', 'tcp', '-i', rtsp, '-frames:v', '1', str(out)], timeout=20)
        check('multiview frame captured', out.exists() and out.stat().st_size > 10000, out)
        await ws.send_json({'t': 'output', 'action': 'stop', 'id': 'o1'})
        await ws.close()
        for p in (pa, pb, bad):
            p.terminate()
    print('ALL PASSED' if not fails else f'{fails} FAILED')
    sys.exit(1 if fails else 0)

asyncio.run(main())
