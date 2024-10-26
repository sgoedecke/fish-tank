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
    fishes: {},
    fishFoods: [],
    worldSize: { width: 400, height: 300 },
    rateLimitExceeded: false
};

// Physics constants remain the same
const ACCELERATION = 0.2;
const MAX_SPEED = 0.3;
const FRICTION = 0.98;
const BOUNCE_FACTOR = 1//0.8;

const AI_DECISION_INTERVAL = 3500 // this will be xed by the number of models. It stays under the rate limit for low-tier models (at least until the daily limit is exceeded)

// Convert game state to ASCII grid
function getASCIIState(fishId) {
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
    
    // Add fishFoods
    gameState.fishFoods.forEach(fishFood => {
        const pos = scaleToGrid(fishFood.x, fishFood.y);
        if (pos.x >= 0 && pos.x < gridWidth && pos.y >= 0 && pos.y < gridHeight) {
            grid[pos.y][pos.x] = 'o';
        }
    });
    
    // Add fishes
    Object.entries(gameState.fishes).forEach(([id, fish]) => {
        const pos = scaleToGrid(fish.x, fish.y);
        if (pos.x >= 0 && pos.x < gridWidth && pos.y >= 0 && pos.y < gridHeight) {
            grid[pos.y][pos.x] = id === fishId ? 'S' : '.'; // don't show enemy fishes
        }
    });
    
    // Convert grid to string
    return grid.map(row => row.join('')).join('\n');
}

// Bot configurations
const BOTS = [
    // { id: 'bot0', name: 'GPT 4o', color: '#FF6B6B', model: 'gpt-4o' },
    // { id: 'bot1', name: 'Llama-3.2-11B-Vision-Instruct', color: '#4ECDC4', model: 'Llama-3.2-11B-Vision-Instruct' },
    { id: 'bot2', name: 'GPT 4o-mini', color: 'blue', model: 'gpt-4o-mini' },
    // { id: 'bot3', name: 'Meta-Llama-3.1-8B-Instruct', color: '#96CEB4', model: 'Meta-Llama-3.1-8B-Instruct' },
    { id: 'bot4', name: 'Phi-3-small-8k-instruct', color: 'purple', model: 'Phi-3-small-8k-instruct' },
    { id: 'bot5', name: 'Phi-3-medium-4k-instruct', color: '#FF8C00', model: 'Phi-3-medium-4k-instruct' },
    // { id: 'bot6', name: 'AI21-Jamba-1.5-Mini', color: '#FFEEEE', model: 'AI21-Jamba-1.5-Mini' },
];

// Initialize bots with configurations
BOTS.forEach(botConfig => {
    gameState.fishes[botConfig.id] = {
        x: Math.random() * gameState.worldSize.width,
        y: Math.random() * gameState.worldSize.height,
        velocity: { x: 0, y: 0 },
        direction: { x: 0, y: 0 },
        moving: true,
        score: 0,
        name: botConfig.name,
        color: botConfig.color,
        model: botConfig.model,
        history: []
    };
});

function extractLastCoordinates(text) {
    // Regular expression to capture two floating point numbers (including possible minus signs and decimals)
    const regex = /(-?\d*\.?\d+),\s*(-?\d*\.?\d+)/g;
    let match;
    let lastMatch = null;

    // Iterate over all matches to get the last one
    while ((match = regex.exec(text)) !== null) {
        lastMatch = match;
    }

    if (lastMatch) {
        // Return the last numbers as an array of floats
        return [parseFloat(lastMatch[1]), parseFloat(lastMatch[2])];
    } else {
        return null; // Return null if no match is found
    }
}

// Modified AI direction function to include logging
async function getAIDirection(fishId) {
    const fish = gameState.fishes[fishId];
    const asciiState = getASCIIState(fishId);

    // normalize fish.direction into a basis vector
    let length = Math.sqrt(fish.direction.x * fish.direction.x + fish.direction.y * fish.direction.y);
    if (length == 0) { length = 1; } // avoid division by zero
    const basis = { x: fish.direction.x / length, y: fish.direction.y / length };

    const lastHistoryItem = asciiState + '\n\n' + `${basis.x},${basis.y}` + '\n\n------\n\n'
    fish.history.push(lastHistoryItem);
    // if history is > 3, remove the oldest entry
    if (fish.history.length > 3) {
        fish.history.shift();
    }

    const prompt = `You are ${fish.name}, a fish AI in a game. The game state is shown below as ASCII:
'.' is empty space
'o' is a piece of fish food
'S' is your fish

You must move towards the nearest fish food in order to collect it before enemy fishes can!
The game space is surrounded by walls you cannot pass through.
You can only change direction every few seconds, so try and get it right the first time.

Decide where to move, based on this game state. Remember that you are 'S' and you want to move towards the nearest 'o'.:
${asciiState}

Be brief. Your response must finish with two numbers between -1 and 1 representing x and y direction vectors, separated by a comma.
The vectors are relative to an 0,0 position in the top left of the screen.
The first number is the horizontal (x) direction: -1 is left, 1 is right.
The second number is the vertical (y) direction: -1 is up, 1 is down.
For example: "0.5,-0.7" will move the fish south-east. "0.0,1.0" will move the fish directly down.`;

console.log('\n\n', prompt)

    try {

        if (gameState.rateLimitExceeded) {
            throw new Error('Rate limit exceeded');
       }

        const response = await client.path("/chat/completions").post({
            body: {
                messages: [{ role: "user", content: prompt }],
                model: fish.model
            }
        });

        if (response.status === "200") {
            const responseText = response.body.choices[0].message.content.trim();


            
            // Emit log message to clients
            io.emit('botLog', {
                fishId,
                name: fish.name,
                color: fish.color,
                message: `Direction: ${responseText}`,
                timestamp: new Date().toLocaleTimeString()
            });

            let [x,y] = extractLastCoordinates(responseText)

            if (!isNaN(x) && !isNaN(y) && Math.abs(x) <= 1 && Math.abs(y) <= 1) {
                const length = Math.sqrt(x * x + y * y);
                if (length > 0) {
                    return { x: x / length, y: y / length };
                }
            }
        } else {
            if (response.status == 429) {
                gameState.rateLimitExceeded = true;
                setTimeout(() => {
                    gameState.rateLimitExceeded = false;
                }, 60 * 10 * 1000); // 10 minute timeout
                throw new Error('Rate limit exceeded');
            }
            io.emit('botLog', {
                fishId,
                name: fish.name,
                color: fish.color,
                message: `Error: Falling back to no movement, response status: ${response.status} and body: ${response.body}`,
                timestamp: new Date().toLocaleTimeString()
            });
        }
    } catch (error) {
        io.emit('botLog', {
            fishId,
            name: fish.name,
            color: fish.color,
            message: `Error: Falling back to no movement, ${error.message}`,
            timestamp: new Date().toLocaleTimeString()
        });
    }
    
    return false
}

// Update bot directions using AI
async function updateBotDirections() {
    for (const fishId of Object.keys(gameState.fishes)) {
        const newDirection = await getAIDirection(fishId);
        if (newDirection) {
            gameState.fishes[fishId].direction = newDirection;
        }
    }
}

// Set up periodic direction updates
// To stay under the rate limits for Low models, we have to sit at 1 request every 3-4 seconds in total
const interval = AI_DECISION_INTERVAL * Object.keys(gameState.fishes).length;

spawnFishFood() // make sure there's a goal to start with before we ask the AIs what to do

setInterval(() => {
    updateBotDirections().catch(console.error);
}, interval);

// Initialize  directions for all bots
updateBotDirections().catch(console.error);

function checkWallCollision(fish) {
    let collided = false;
    
    if (fish.x - SHIP_RADIUS < 0) {
        fish.x = SHIP_RADIUS;
        fish.velocity.x = Math.abs(fish.velocity.x) * BOUNCE_FACTOR;
        collided = true;
    } else if (fish.x + SHIP_RADIUS > gameState.worldSize.width) {
        fish.x = gameState.worldSize.width - SHIP_RADIUS;
        fish.velocity.x = -Math.abs(fish.velocity.x) * BOUNCE_FACTOR;
        collided = true;
    }
    
    if (fish.y - SHIP_RADIUS < 0) {
        fish.y = SHIP_RADIUS;
        fish.velocity.y = Math.abs(fish.velocity.y) * BOUNCE_FACTOR;
        collided = true;
    } else if (fish.y + SHIP_RADIUS > gameState.worldSize.height) {
        fish.y = gameState.worldSize.height - SHIP_RADIUS;
        fish.velocity.y = -Math.abs(fish.velocity.y) * BOUNCE_FACTOR;
        collided = true;
    }
    
    return collided;
}

function checkFishCollisions() {
    const fishes = Object.values(gameState.fishes);
    for (let i = 0; i < fishes.length; i++) {
        for (let j = i + 1; j < fishes.length; j++) {
            const fish1 = fishes[i];
            const fish2 = fishes[j];
            
            const dx = fish2.x - fish1.x;
            const dy = fish2.y - fish1.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            if (distance < SHIP_RADIUS * 2) {
                // Normalize collision vector
                const nx = dx / distance;
                const ny = dy / distance;
                
                // Relative velocity
                const vx = fish1.velocity.x - fish2.velocity.x;
                const vy = fish1.velocity.y - fish2.velocity.y;
                
                // Relative velocity in normal direction
                const normalVelocity = vx * nx + vy * ny;
                
                // Only resolve collision if objects are moving toward each other
                if (normalVelocity < 0) {
                    // Collision response
                    const restitution = BOUNCE_FACTOR;
                    const impulse = -(1 + restitution) * normalVelocity / 2;
                    
                    // Apply impulse
                    fish1.velocity.x -= impulse * nx;
                    fish1.velocity.y -= impulse * ny;
                    fish2.velocity.x += impulse * nx;
                    fish2.velocity.y += impulse * ny;
                    
                    // Separate fishes to prevent sticking
                    const overlap = (SHIP_RADIUS * 2 - distance) / 2;
                    fish1.x -= nx * overlap;
                    fish1.y -= ny * overlap;
                    fish2.x += nx * overlap;
                    fish2.y += ny * overlap;
                }
            }
        }
    }
}

function updateFish(fish) {
    // Update velocity based on direction
    fish.velocity.x += fish.direction.x * ACCELERATION;
    fish.velocity.y += fish.direction.y * ACCELERATION;
    
    // Apply friction
    fish.velocity.x *= FRICTION;
    fish.velocity.y *= FRICTION;
    
    // Limit speed
    const speed = Math.sqrt(fish.velocity.x ** 2 + fish.velocity.y ** 2);
    if (speed > MAX_SPEED) {
        fish.velocity.x = (fish.velocity.x / speed) * MAX_SPEED;
        fish.velocity.y = (fish.velocity.y / speed) * MAX_SPEED;
    }
    
    // Update position
    fish.x += fish.velocity.x;
    fish.y += fish.velocity.y;
    
    // Check wall collisions
    checkWallCollision(fish);
}

function spawnFishFood() {
    if (gameState.fishFoods.length < 2) { // 2 fishFoods max
        gameState.fishFoods.push({
            id: Date.now(),
            x: SHIP_RADIUS + Math.random() * (gameState.worldSize.width - 2 * SHIP_RADIUS),
            y: SHIP_RADIUS + Math.random() * (gameState.worldSize.height - 2 * SHIP_RADIUS)
        });
    }
}

function checkFishFoodCollection(fish) {
    const COLLECTION_DISTANCE = SHIP_RADIUS + 10;
    gameState.fishFoods = gameState.fishFoods.filter(fishFood => {
        const dx = fish.x - fishFood.x;
        const dy = fish.y - fishFood.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < COLLECTION_DISTANCE) {
            fish.score += 1;
            return false;
        }
        return true;
    });
}

// Game loop
setInterval(() => {
    Object.values(gameState.fishes).forEach(fish => {
        updateFish(fish);
        checkFishFoodCollection(fish);
    });
    
    checkFishCollisions();
    
    if (Math.random() < 0.9) spawnFishFood();
    
    io.emit('gameState', gameState);
}, 1000 / 60);

http.listen(3000, () => {
    console.log('Server running on port 3000');
});
