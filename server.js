import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ModelClient from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const http = createServer(app);
const io = new Server(http);

app.use(express.static(join(__dirname, 'public')));

const client = new ModelClient(
    "https://models.inference.ai.azure.com",
    new AzureKeyCredential(process.env.GITHUB_TOKEN)
);

// Game constants
const SHIP_RADIUS = 15;
const GRID_SIZE = 20; // Size of ASCII grid

const gameState = {
    ships: {},
    doubloons: [],
    worldSize: { width: 800, height: 600 }
};

// Physics constants remain the same
const ACCELERATION = 0.2;
const MAX_SPEED = 3;
const FRICTION = 0.98;
const BOUNCE_FACTOR = 0.8;

// Convert game state to ASCII grid
function getASCIIState(shipId) {
    const gridWidth = GRID_SIZE;
    const gridHeight = Math.floor(GRID_SIZE * (gameState.worldSize.height / gameState.worldSize.width));
    let grid = Array(gridHeight).fill().map(() => Array(gridWidth).fill('.'));
    
    // Scale coordinates to grid size
    function scaleToGrid(x, y) {
        return {
            x: Math.floor((x / gameState.worldSize.width) * gridWidth),
            y: Math.floor((y / gameState.worldSize.height) * gridHeight)
        };
    }
    
    // Add doubloons
    gameState.doubloons.forEach(doubloon => {
        const pos = scaleToGrid(doubloon.x, doubloon.y);
        if (pos.x >= 0 && pos.x < gridWidth && pos.y >= 0 && pos.y < gridHeight) {
            grid[pos.y][pos.x] = 'o';
        }
    });
    
    // Add ships
    Object.entries(gameState.ships).forEach(([id, ship]) => {
        const pos = scaleToGrid(ship.x, ship.y);
        if (pos.x >= 0 && pos.x < gridWidth && pos.y >= 0 && pos.y < gridHeight) {
            grid[pos.y][pos.x] = id === shipId ? 'S' : 'E';
        }
    });
    
    // Convert grid to string
    return grid.map(row => row.join('')).join('\n');
}

// Bot configurations
const BOTS = [
    // { id: 'bot0', name: 'GPT 4o-mini', color: '#FF6B6B', model: 'gpt-4o-mini' },
    // { id: 'bot1', name: 'Mistral-small', color: '#4ECDC4', model: 'Mistral-small' },
    // { id: 'bot2', name: 'GPT 4o', color: '#45B7D1', model: 'gpt-4o'},
    { id: 'bot3', name: 'Meta-Llama-3.1-8B-Instruct', color: '#96CEB4', model: 'Meta-Llama-3.1-8B-Instruct' },
    { id: 'bot4', name: 'Phi-3-small-8k-instruct', color: '#FFEEAD', model: 'Phi-3-small-8k-instruct' }
];

// Initialize bots with configurations
BOTS.forEach(botConfig => {
    gameState.ships[botConfig.id] = {
        x: Math.random() * gameState.worldSize.width,
        y: Math.random() * gameState.worldSize.height,
        velocity: { x: 0, y: 0 },
        direction: { x: 0, y: 0 },
        moving: true,
        score: 0,
        name: botConfig.name,
        color: botConfig.color,
        model: botConfig.model
    };
});

// Modified AI direction function to include logging
async function getAIDirection(shipId) {
    const ship = gameState.ships[shipId];
    const asciiState = getASCIIState(shipId);
    
    const prompt = `You are ${ship.name}, a pirate ship AI in a game. The game state is shown below as ASCII:
'.' is empty space
'o' is a doubloon (treasure)
'S' is your ship
'E' is enemy ships

You must move towards the nearest doubloon in order to collect it before enempy ships can!

Your current score is ${ship.score}. Decide where to move:
${asciiState}

Respond with ONLY two numbers between -1 and 1 representing x and y direction vectors, separated by a comma. For example: "0.5,-0.7"`;

    try {
        const response = await client.path("/chat/completions").post({
            body: {
                messages: [{ role: "user", content: prompt }],
                model: ship.model
            }
        });

        if (response.status === "200") {
            const directionStr = response.body.choices[0].message.content.trim();
            
            // Emit log message to clients
            io.emit('botLog', {
                shipId,
                name: ship.name,
                color: ship.color,
                message: `Direction: ${directionStr}`,
                timestamp: new Date().toLocaleTimeString()
            });

            const [x, y] = directionStr.split(',').map(Number);
            if (!isNaN(x) && !isNaN(y) && Math.abs(x) <= 1 && Math.abs(y) <= 1) {
                const length = Math.sqrt(x * x + y * y);
                if (length > 0) {
                    return { x: x / length, y: y / length };
                }
            }
        } else {
            if (response.status == 429) {
                throw new Error('Rate limit exceeded');
            }
            io.emit('botLog', {
                shipId,
                name: ship.name,
                color: ship.color,
                message: `Error: Falling back to no movement, response status: ${response.status} and body: ${response.body}`,
                timestamp: new Date().toLocaleTimeString()
            });
        }
    } catch (error) {
        io.emit('botLog', {
            shipId,
            name: ship.name,
            color: ship.color,
            message: `Error: Falling back to no movement, ${error.message}`,
            timestamp: new Date().toLocaleTimeString()
        });
    }
    
    return false
}

// Update bot directions using AI
async function updateBotDirections() {
    for (const shipId of Object.keys(gameState.ships)) {
        const newDirection = await getAIDirection(shipId);
        if (newDirection) {
            gameState.ships[shipId].direction = newDirection;
        }
    }
}

// Set up periodic direction updates
setInterval(() => {
    updateBotDirections().catch(console.error);
}, 3000);


// Initialize random directions for all bots
Object.values(gameState.ships).forEach(updateBotDirections);

// Set up periodic direction changes
setInterval(() => {
    Object.values(gameState.ships).forEach(updateBotDirections);
}, 3000);

function checkWallCollision(ship) {
    let collided = false;
    
    if (ship.x - SHIP_RADIUS < 0) {
        ship.x = SHIP_RADIUS;
        ship.velocity.x = Math.abs(ship.velocity.x) * BOUNCE_FACTOR;
        collided = true;
    } else if (ship.x + SHIP_RADIUS > gameState.worldSize.width) {
        ship.x = gameState.worldSize.width - SHIP_RADIUS;
        ship.velocity.x = -Math.abs(ship.velocity.x) * BOUNCE_FACTOR;
        collided = true;
    }
    
    if (ship.y - SHIP_RADIUS < 0) {
        ship.y = SHIP_RADIUS;
        ship.velocity.y = Math.abs(ship.velocity.y) * BOUNCE_FACTOR;
        collided = true;
    } else if (ship.y + SHIP_RADIUS > gameState.worldSize.height) {
        ship.y = gameState.worldSize.height - SHIP_RADIUS;
        ship.velocity.y = -Math.abs(ship.velocity.y) * BOUNCE_FACTOR;
        collided = true;
    }
    
    return collided;
}

function checkShipCollisions() {
    const ships = Object.values(gameState.ships);
    for (let i = 0; i < ships.length; i++) {
        for (let j = i + 1; j < ships.length; j++) {
            const ship1 = ships[i];
            const ship2 = ships[j];
            
            const dx = ship2.x - ship1.x;
            const dy = ship2.y - ship1.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            if (distance < SHIP_RADIUS * 2) {
                // Normalize collision vector
                const nx = dx / distance;
                const ny = dy / distance;
                
                // Relative velocity
                const vx = ship1.velocity.x - ship2.velocity.x;
                const vy = ship1.velocity.y - ship2.velocity.y;
                
                // Relative velocity in normal direction
                const normalVelocity = vx * nx + vy * ny;
                
                // Only resolve collision if objects are moving toward each other
                if (normalVelocity < 0) {
                    // Collision response
                    const restitution = BOUNCE_FACTOR;
                    const impulse = -(1 + restitution) * normalVelocity / 2;
                    
                    // Apply impulse
                    ship1.velocity.x -= impulse * nx;
                    ship1.velocity.y -= impulse * ny;
                    ship2.velocity.x += impulse * nx;
                    ship2.velocity.y += impulse * ny;
                    
                    // Separate ships to prevent sticking
                    const overlap = (SHIP_RADIUS * 2 - distance) / 2;
                    ship1.x -= nx * overlap;
                    ship1.y -= ny * overlap;
                    ship2.x += nx * overlap;
                    ship2.y += ny * overlap;
                }
            }
        }
    }
}

function updateShip(ship) {
    // Update velocity based on direction
    ship.velocity.x += ship.direction.x * ACCELERATION;
    ship.velocity.y += ship.direction.y * ACCELERATION;
    
    // Apply friction
    ship.velocity.x *= FRICTION;
    ship.velocity.y *= FRICTION;
    
    // Limit speed
    const speed = Math.sqrt(ship.velocity.x ** 2 + ship.velocity.y ** 2);
    if (speed > MAX_SPEED) {
        ship.velocity.x = (ship.velocity.x / speed) * MAX_SPEED;
        ship.velocity.y = (ship.velocity.y / speed) * MAX_SPEED;
    }
    
    // Update position
    ship.x += ship.velocity.x;
    ship.y += ship.velocity.y;
    
    // Check wall collisions
    checkWallCollision(ship);
}

function spawnDoubloon() {
    if (gameState.doubloons.length < 2) {
        gameState.doubloons.push({
            id: Date.now(),
            x: SHIP_RADIUS + Math.random() * (gameState.worldSize.width - 2 * SHIP_RADIUS),
            y: SHIP_RADIUS + Math.random() * (gameState.worldSize.height - 2 * SHIP_RADIUS)
        });
    }
}

function checkDoubloonCollection(ship) {
    const COLLECTION_DISTANCE = SHIP_RADIUS + 5;
    gameState.doubloons = gameState.doubloons.filter(doubloon => {
        const dx = ship.x - doubloon.x;
        const dy = ship.y - doubloon.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < COLLECTION_DISTANCE) {
            ship.score += 1;
            return false;
        }
        return true;
    });
}

// Game loop
setInterval(() => {
    Object.values(gameState.ships).forEach(ship => {
        updateShip(ship);
        checkDoubloonCollection(ship);
    });
    
    checkShipCollisions();
    
    if (Math.random() < 0.9) spawnDoubloon();
    
    io.emit('gameState', gameState);
}, 1000 / 60);

http.listen(3000, () => {
    console.log('Server running on port 3000');
});

// public/index.html
