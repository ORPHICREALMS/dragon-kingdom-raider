const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
    let filePath = '.' + req.url;
    if (filePath === './') filePath = './game.html';
    const ext = path.extname(filePath).toLowerCase();
    const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png' };
    fs.readFile(filePath, (err, content) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
        res.end(content);
    });
});

const wss = new WebSocket.Server({ server });

// One shared room for now
const room = {
    players: new Map(), // ws -> playerData
};

function broadcast(msg, excludeWs = null) {
    const str = JSON.stringify(msg);
    room.players.forEach((p, ws) => {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(str);
    });
}

function getPlayerList(excludeWs = null) {
    const list = [];
    room.players.forEach((p, ws) => {
        if (ws !== excludeWs) list.push({
            name: p.name, x: p.x, y: p.y,
            state: p.state, dead: p.dead,
            bodyX: p.bodyX, bodyY: p.bodyY,
        });
    });
    return list;
}

wss.on('connection', (ws) => {
    let me = null;

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);
            switch (data.type) {

                case 'join':
                    me = {
                        name: data.name,
                        x: 9 * 40, y: 9 * 40,   // undercity start
                        state: 'undercity',
                        dead: false,
                        bodyX: 0, bodyY: 0,
                    };
                    room.players.set(ws, me);

                    // Send this player the full current roster immediately
                    ws.send(JSON.stringify({
                        type: 'init',
                        players: getPlayerList(ws),
                    }));

                    // Tell everyone else this player joined
                    broadcast({ type: 'playerJoined', name: me.name, x: me.x, y: me.y, state: me.state }, ws);
                    console.log(me.name + ' joined. Total: ' + room.players.size);
                    break;

                case 'move':
                    if (!me) break;
                    me.x = data.x; me.y = data.y;
                    me.state = data.state || me.state;
                    broadcast({ type: 'playerMove', name: me.name, x: data.x, y: data.y, facing: data.facing, state: me.state }, ws);
                    break;

                case 'stateChange':
                    if (!me) break;
                    me.state = data.state;
                    if (data.x !== undefined) me.x = data.x;
                    if (data.y !== undefined) me.y = data.y;
                    broadcast({ type: 'playerStateChange', name: me.name, state: data.state, x: me.x, y: me.y }, ws);
                    break;

                case 'playerDied':
                    if (!me) break;
                    me.dead = true;
                    me.bodyX = data.x; me.bodyY = data.y;
                    broadcast({ type: 'playerDied', name: me.name, x: data.x, y: data.y });
                    break;

                case 'revive':
                    // Find the target player and tell them they're revived
                    room.players.forEach((p, targetWs) => {
                        if (p.name === data.target) {
                            p.dead = false;
                            targetWs.send(JSON.stringify({ type: 'revived', revivedBy: me.name }));
                            broadcast({ type: 'playerRevived', name: data.target });
                        }
                    });
                    break;

                case 'collect':
                    if (!me) break;
                    broadcast({ type: 'itemCollected', itemId: data.itemId, by: me.name });
                    break;

                case 'chat':
                    if (!me) break;
                    if (typeof data.text === 'string' && data.text.trim()) {
                        broadcast({ type: 'chat', name: me.name, text: data.text.trim().slice(0,120) });
                    }
                    break;
            }
        } catch (e) {
            console.error('Message error:', e);
        }
    });

    ws.on('close', () => {
        if (me) {
            room.players.delete(ws);
            broadcast({ type: 'playerLeft', name: me.name });
            console.log(me.name + ' left. Total: ' + room.players.size);
        }
    });

    ws.on('error', (e) => console.error('WS error:', e));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Dragon Raiders running at http://localhost:' + PORT));
