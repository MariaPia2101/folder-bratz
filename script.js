import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Scene setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

// Camera setup
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
// Avviciniamo molto la camera per essere sicuri che inizi ALL'INTERNO della stanza
camera.position.set(0, 1.5, 2.5);

// Renderer setup
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// Controls (li teniamo ma li limitiamo per evitare di attraversare i muri)
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI / 2 - 0.05; // Non andare sotto il pavimento
controls.minDistance = 1; // Distanza minima dal personaggio
controls.maxDistance = 3.5; // Distanza massima ridotta per non uscire dalla stanza

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
directionalLight.position.set(10, 20, 10);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.width = 2048;
directionalLight.shadow.mapSize.height = 2048;
directionalLight.shadow.camera.near = 0.5;
directionalLight.shadow.camera.far = 50;
directionalLight.shadow.camera.left = -20;
directionalLight.shadow.camera.right = 20;
directionalLight.shadow.camera.top = 20;
directionalLight.shadow.camera.bottom = -20;
scene.add(directionalLight);

// Variables for character and animation
let character;
let mixer;
let walkAction;
let idleAction;
let currentAction;
let characterHeightOffset = 0; // Salva l'offset per mantenere i piedi a terra

// Input state
const keys = {
    w: false,
    a: false,
    s: false,
    d: false
};

document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (keys.hasOwnProperty(key)) keys[key] = true;
});

document.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (keys.hasOwnProperty(key)) keys[key] = false;
});

// Loaders
const loadingElement = document.getElementById('loading');
const loadingManager = new THREE.LoadingManager(
    () => {
        if (loadingElement) loadingElement.style.display = 'none';
    },
    (itemUrl, itemsLoaded, itemsTotal) => {
        if (loadingElement) {
            loadingElement.innerText = `Caricamento... ${Math.round((itemsLoaded / itemsTotal) * 100)}%`;
        }
    }
);

const gltfLoader = new GLTFLoader(loadingManager);

// Load Environment
gltfLoader.load(
    'assets/3d/environment.glb',
    (gltf) => {
        const environment = gltf.scene;
        environment.traverse((child) => {
            if (child.isMesh) {
                child.receiveShadow = true;
                child.castShadow = true;
                collidableMeshes.push(child); // Aggiungi la mesh per le collisioni
            }
        });
        scene.add(environment);
    }
);

// Load Character
gltfLoader.load(
    'assets/3d/character.glb',
    (gltf) => {
        character = gltf.scene;
        character.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });
        
        // Regoliamo l'altezza del personaggio. Modifica questo valore se necessario.
        // Calcoliamo la bounding box per posizionarlo esattamente a terra
        const box = new THREE.Box3().setFromObject(character);
        if (!box.isEmpty() && isFinite(box.min.y)) {
            characterHeightOffset = -box.min.y;
            // Assicuriamoci che i piedi tocchino lo zero (Y=0)
            character.position.y = characterHeightOffset;
        } else {
            character.position.y = 0;
        }
        
        scene.add(character);

        // Setup animations
        if (gltf.animations && gltf.animations.length > 0) {
            mixer = new THREE.AnimationMixer(character);
            
            // Proviamo a trovare animazioni di walk/idle dai nomi (altrimenti usiamo le prime)
            const idleClip = THREE.AnimationClip.findByName(gltf.animations, 'Idle') || gltf.animations[0];
            const walkClip = THREE.AnimationClip.findByName(gltf.animations, 'Walk') || gltf.animations[1] || gltf.animations[0];
            
            if (idleClip) idleAction = mixer.clipAction(idleClip);
            if (walkClip) walkAction = mixer.clipAction(walkClip);
            
            if (idleAction) {
                idleAction.play();
                currentAction = idleAction;
            }
        }
        
        // Set camera target to character
        controls.target.copy(character.position);
    }
);

// Movement and Physics settings
const moveSpeed = 5.0; // Unità al secondo
const rotationSpeed = 5.0; // Radianti al secondo
const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const collidableMeshes = [];

// Window resize handler
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Animation loop
function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    if (mixer) mixer.update(delta);

    if (character) {
        let isMoving = false;
        
        // Calcola la direzione basata sull'input
        const moveDir = new THREE.Vector3(0, 0, 0);
        
        if (keys.w) moveDir.z -= 1;
        if (keys.s) moveDir.z += 1;
        if (keys.a) moveDir.x -= 1;
        if (keys.d) moveDir.x += 1;
        
        if (moveDir.lengthSq() > 0) {
            isMoving = true;
            moveDir.normalize();
            
            // Calcola l'angolo in base alla rotazione della camera
            const cameraAngle = Math.atan2(camera.position.x - character.position.x, camera.position.z - character.position.z);
            
            // L'angolo desiderato del personaggio
            const targetAngle = Math.atan2(moveDir.x, moveDir.z) + cameraAngle;
            
            // Smooth rotation del personaggio
            let diff = targetAngle - character.rotation.y;
            // Normalizza l'angolo per ruotare dalla parte più corta
            diff = Math.atan2(Math.sin(diff), Math.cos(diff));
            character.rotation.y += diff * rotationSpeed * delta;
            
            // Movimento reale nello spazio
            const moveX = Math.sin(character.rotation.y) * moveSpeed * delta;
            const moveZ = Math.cos(character.rotation.y) * moveSpeed * delta;
            
            // Raycasting Frontale per i muri
            const forwardDir = new THREE.Vector3(moveX, 0, moveZ).normalize();
            // Lancia il raggio dal petto del personaggio
            const originFront = new THREE.Vector3(character.position.x, character.position.y + 1, character.position.z);
            raycaster.set(originFront, forwardDir);
            
            const frontIntersects = raycaster.intersectObjects(collidableMeshes, false);
            
            let canMove = true;
            // Se colpisce un ostacolo a meno di 0.5 metri (raggio del personaggio), bloccati
            if (frontIntersects.length > 0 && frontIntersects[0].distance < 0.5) {
                canMove = false;
            }
            
            if (canMove) {
                character.position.x += moveX;
                character.position.z += moveZ;
            }
        }
        
        // Raycasting verso il basso per Pavimento e Scale
        // Lancia un raggio partendo da sopra la testa verso il basso
        const originDown = new THREE.Vector3(character.position.x, character.position.y + 2, character.position.z);
        const downDir = new THREE.Vector3(0, -1, 0);
        raycaster.set(originDown, downDir);
        
        const downIntersects = raycaster.intersectObjects(collidableMeshes, false);
        if (downIntersects.length > 0) {
            // Punto di impatto rilevato + offset calcolato precedentemente per tenere i piedi a terra
            const targetY = downIntersects[0].point.y + characterHeightOffset;
            
            // Interpolazione lineare per salire gradini in modo fluido senza scatti bruschi
            character.position.y += (targetY - character.position.y) * 10 * delta;
        }
        
        // Gestione transizione animazioni
        if (isMoving && walkAction && currentAction !== walkAction) {
            if (currentAction) currentAction.fadeOut(0.2);
            walkAction.reset().fadeIn(0.2).play();
            currentAction = walkAction;
        } else if (!isMoving && idleAction && currentAction !== idleAction) {
            if (currentAction) currentAction.fadeOut(0.2);
            idleAction.reset().fadeIn(0.2).play();
            currentAction = idleAction;
        }
        
        // Mantieni la camera in target sul personaggio
        controls.target.set(character.position.x, character.position.y + 1, character.position.z);
    }

    controls.update();
    renderer.render(scene, camera);
}

animate();
