import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ─── SCENE ────────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

// ─── CAMERA ───────────────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 2, 5);

// ─── RENDERER ─────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

// ─── ENVIRONMENT MAP (RoomEnvironment) ────────────────────────────────────────
// RoomEnvironment simula un interno con pareti, soffitto e pavimento —
// è la soluzione corretta per materiali PBR (metallici, lucidi) in ambienti chiusi.
const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();
const roomEnv = new RoomEnvironment();
const envTexture = pmremGenerator.fromScene(roomEnv).texture;
scene.environment = envTexture;  // Applicata SOLO come sorgente di riflessi, non come sfondo
roomEnv.dispose();
pmremGenerator.dispose();

// ─── CONTROLS ─────────────────────────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI / 2 - 0.05;
controls.minDistance = 1;
controls.maxDistance = 4;

// ─── LIGHTING ─────────────────────────────────────────────────────────────────
// Luce ambientale soft — la RoomEnvironment fornisce già i riflessi,
// le luci fisiche gestiscono le ombre e la direzionalità.
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
directionalLight.position.set(5, 15, 8);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.width = 2048;
directionalLight.shadow.mapSize.height = 2048;
directionalLight.shadow.camera.near = 0.5;
directionalLight.shadow.camera.far = 60;
directionalLight.shadow.camera.left = -20;
directionalLight.shadow.camera.right = 20;
directionalLight.shadow.camera.top = 20;
directionalLight.shadow.camera.bottom = -20;
scene.add(directionalLight);

// ─── STATE VARIABILI ──────────────────────────────────────────────────────────
let character = null;
let mixer = null;
let walkAction, idleAction, currentAction;
let characterHeightOffset = 0;
let floorY = 0;           // Y del pavimento reale, calcolata dall'ambiente
let characterGrounded = false; // Diventa true dopo il primo ancoraggio al pavimento

// ROOM_LIMITS: calcolati dal bounding box SOLO del pavimento (non dell'intera scena)
const ROOM_LIMITS = { minX: -15, maxX: 15, minZ: -15, maxZ: 15 };

// ─── INPUT ────────────────────────────────────────────────────────────────────
const keys = { w: false, a: false, s: false, d: false };
document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (key in keys) keys[key] = true;
});
document.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (key in keys) keys[key] = false;
});

// ─── LOADERS ──────────────────────────────────────────────────────────────────
const loadingElement = document.getElementById('loading');
const loadingManager = new THREE.LoadingManager(
    () => { if (loadingElement) loadingElement.style.display = 'none'; },
    (url, loaded, total) => {
        if (loadingElement)
            loadingElement.innerText = `Caricamento... ${Math.round((loaded / total) * 100)}%`;
    }
);

const collidableMeshes = [];   // meshes per collisioni laterali (muri)
const floorMeshes = [];        // meshes SOLO del pavimento per raycast verticale

const gltfLoader = new GLTFLoader(loadingManager);

// ─── CARICAMENTO AMBIENTE ─────────────────────────────────────────────────────
gltfLoader.load(
    'assets/3d/ambiente.glb',
    (gltfEnv) => {
        console.log('✅ Ambiente caricato');
        const environment = gltfEnv.scene;
        environment.visible = true;

        // ── FIX MATERIALI ──────────────────────────────────────────────────────
        // Non tocchiamo roughness/metalness/opacity: li rispettiamo dall'export Blender.
        // Impostiamo solo DoubleSide per prevenire backface culling su superfici sottili.
        environment.traverse((child) => {
            if (!child.isMesh) return;
            child.visible = true;
            child.receiveShadow = true;
            child.castShadow = true;

            const applyFix = (m) => {
                m.side = THREE.DoubleSide;
                // Attiva trasparenza solo se l'opacity del materiale lo richiede
                if (m.opacity < 1.0 || m.alphaTest > 0) {
                    m.transparent = true;
                }
                m.needsUpdate = true;
            };

            if (Array.isArray(child.material)) {
                child.material.forEach(applyFix);
            } else {
                applyFix(child.material);
            }

            collidableMeshes.push(child);
        });

        scene.add(environment);

        // ── CALCOLO FLOOR Y E BOUNDING BOX DEL PAVIMENTO ───────────────────────
        // Strategia: troviamo la Y minima globale di tutta la scena (= livello pavimento).
        // Poi raccogliamo SOLO le mesh il cui minY è entro 0.2 unità dal minY globale:
        // queste sono le mesh del pavimento. Il loro bounding box XZ definisce i muri.

        const globalBox = new THREE.Box3().setFromObject(environment);
        floorY = globalBox.min.y;
        console.log('📏 Floor Y globale:', floorY);

        // Box XZ esclusivo del pavimento
        const floorBox = new THREE.Box3();
        floorBox.makeEmpty();

        environment.traverse((child) => {
            if (!child.isMesh) return;
            const meshBox = new THREE.Box3().setFromObject(child);
            // Se il bottom della mesh è entro 0.25 dal pavimento → è una mesh di pavimento
            if (Math.abs(meshBox.min.y - floorY) < 0.25) {
                floorMeshes.push(child);
                floorBox.union(meshBox);
                console.log(`  🟫 Floor mesh: "${child.name}" | minY=${meshBox.min.y.toFixed(3)}`);
            }
        });

        // Se non abbiamo trovato mesh di pavimento, usiamo il box globale come fallback
        let roomBox = floorBox.isEmpty() ? globalBox : floorBox;
        const roomSize = new THREE.Vector3();
        roomBox.getSize(roomSize);
        const roomCenter = new THREE.Vector3();
        roomBox.getCenter(roomCenter);

        console.log('📐 Room Box (pavimento):', roomBox);
        console.log('📐 Room Size (XZ):', roomSize.x.toFixed(2), 'x', roomSize.z.toFixed(2));

        // Aggiorna ROOM_LIMITS dal bounding box del PAVIMENTO
        ROOM_LIMITS.minX = roomBox.min.x;
        ROOM_LIMITS.maxX = roomBox.max.x;
        ROOM_LIMITS.minZ = roomBox.min.z;
        ROOM_LIMITS.maxZ = roomBox.max.z;
        console.log('🔒 ROOM_LIMITS:', ROOM_LIMITS);

        // ── CREAZIONE PARETI BIANCHE ────────────────────────────────────────────
        // Altezza: 4 unità (abbastanza da contenere il personaggio)
        // Posizionate esattamente sui bordi XZ del pavimento
        const wallHeight = 4.0;
        const wallThick = 0.3;
        const wallY = floorY + wallHeight / 2; // centro verticale della parete

        const wallMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.85,
            metalness: 0.0,
            side: THREE.DoubleSide
        });

        const wallDefs = [
            // [larg, prof, posX, posZ, nome]
            [roomSize.x, wallThick, roomCenter.x, ROOM_LIMITS.minZ, 'wall_N'],
            [roomSize.x, wallThick, roomCenter.x, ROOM_LIMITS.maxZ, 'wall_S'],
            [wallThick, roomSize.z, ROOM_LIMITS.minX, roomCenter.z, 'wall_W'],
            [wallThick, roomSize.z, ROOM_LIMITS.maxX, roomCenter.z, 'wall_E'],
        ];

        wallDefs.forEach(([w, d, px, pz, name]) => {
            const geo = new THREE.BoxGeometry(w, wallHeight, d);
            const mesh = new THREE.Mesh(geo, wallMat);
            mesh.name = name;
            mesh.position.set(px, wallY, pz);
            mesh.receiveShadow = true;
            scene.add(mesh);
            collidableMeshes.push(mesh);
        });

        // ── SPAWN POINT ────────────────────────────────────────────────────────
        // Centro del pavimento, 1 unità sopra il floorY
        const spawnX = roomCenter.x;
        const spawnZ = roomCenter.z;
        const spawnY = floorY + 1.0;

        // ── CARICAMENTO PERSONAGGIO (sequenziale, dopo ambiente pronto) ─────────
        console.log('⏳ Caricamento personaggio...');
        gltfLoader.load(
            'assets/3d/character.glb',
            (gltfChar) => {
                console.log('✅ Personaggio caricato');
                character = gltfChar.scene;

                character.traverse((child) => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });

                // Calcolo offset altezza: quanto dista il punto più basso del modello
                // dall'origine locale (serve per tenere i piedi ESATTAMENTE a terra)
                const charBox = new THREE.Box3().setFromObject(character);
                if (!charBox.isEmpty() && isFinite(charBox.min.y)) {
                    characterHeightOffset = -charBox.min.y;
                    console.log('📏 characterHeightOffset:', characterHeightOffset);
                }

                // Posizionamento iniziale: centro stanza, piedi sul pavimento
                character.position.set(spawnX, spawnY + characterHeightOffset, spawnZ);
                scene.add(character);

                // ── ANIMAZIONI ─────────────────────────────────────────────────
                if (gltfChar.animations && gltfChar.animations.length > 0) {
                    mixer = new THREE.AnimationMixer(character);
                    const idleClip = THREE.AnimationClip.findByName(gltfChar.animations, 'Idle') || gltfChar.animations[0];
                    const walkClip = THREE.AnimationClip.findByName(gltfChar.animations, 'Walk') || gltfChar.animations[1] || gltfChar.animations[0];
                    if (idleClip) idleAction = mixer.clipAction(idleClip);
                    if (walkClip) walkAction = mixer.clipAction(walkClip);
                    if (idleAction) { idleAction.play(); currentAction = idleAction; }
                }

                // ── CAMERA INIZIALE ────────────────────────────────────────────
                controls.target.copy(character.position);
                camera.position.set(
                    character.position.x,
                    character.position.y + 2,
                    character.position.z + 5
                );
                controls.update();
            },
            undefined,
            (err) => console.error('❌ Errore caricamento personaggio:', err)
        );
    },
    undefined,
    (err) => console.error('❌ Errore caricamento ambiente:', err)
);

// ─── PHYSICS ──────────────────────────────────────────────────────────────────
const moveSpeed = 5.0;
const rotationSpeed = 5.0;
const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
// Il raggio verso il basso viene lanciato da 10 unità sopra e copre 20 unità in totale
// → garantisce intersezione anche se il personaggio è già a Y=0
const RAY_DOWN_ORIGIN_OFFSET = 10;
const RAY_DOWN_MAX_DIST = 20;

// ─── RESIZE ───────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── ANIMATE LOOP ─────────────────────────────────────────────────────────────
function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    if (mixer) mixer.update(delta);

    if (character) {
        let isMoving = false;
        const moveDir = new THREE.Vector3();

        if (keys.w) moveDir.z -= 1;
        if (keys.s) moveDir.z += 1;
        if (keys.a) moveDir.x -= 1;
        if (keys.d) moveDir.x += 1;

        if (moveDir.lengthSq() > 0) {
            isMoving = true;
            moveDir.normalize();

            // Direzione relativa alla camera
            const cameraAngle = Math.atan2(
                camera.position.x - character.position.x,
                camera.position.z - character.position.z
            );
            const targetAngle = Math.atan2(moveDir.x, moveDir.z) + cameraAngle;

            // Smooth rotation
            let diff = targetAngle - character.rotation.y;
            diff = Math.atan2(Math.sin(diff), Math.cos(diff));
            character.rotation.y += diff * rotationSpeed * delta;

            const moveX = Math.sin(character.rotation.y) * moveSpeed * delta;
            const moveZ = Math.cos(character.rotation.y) * moveSpeed * delta;

            // ── COLLISIONE FRONTALE (raycasting laterale) ───────────────────
            const forwardDir = new THREE.Vector3(moveX, 0, moveZ).normalize();
            const originFront = new THREE.Vector3(
                character.position.x,
                character.position.y + 1,
                character.position.z
            );
            raycaster.set(originFront, forwardDir);
            raycaster.far = 0.6;
            const frontHits = raycaster.intersectObjects(collidableMeshes, false);
            if (frontHits.length === 0 || frontHits[0].distance >= 0.5) {
                character.position.x += moveX;
                character.position.z += moveZ;
            }
            raycaster.far = Infinity; // reset per il prossimo uso
        }

        // ── COLLISIONE VERTICALE (ancoraggio al pavimento) ──────────────────
        // Raggio lanciato da molto in alto → cattura il pavimento in ogni condizione
        const originDown = new THREE.Vector3(
            character.position.x,
            character.position.y + RAY_DOWN_ORIGIN_OFFSET,
            character.position.z
        );
        raycaster.set(originDown, new THREE.Vector3(0, -1, 0));
        raycaster.far = RAY_DOWN_MAX_DIST;

        // Usiamo solo le mesh del pavimento per il raycast verticale:
        // evita che il personaggio "si attacchi" a oggetti alti (tavoli, sedie, ecc.)
        const downHits = raycaster.intersectObjects(floorMeshes, false);

        if (downHits.length > 0) {
            const targetY = downHits[0].point.y + characterHeightOffset;

            if (!characterGrounded) {
                // Prima volta: snap immediato senza lerp (evita il "flottare" iniziale)
                character.position.y = targetY;
                characterGrounded = true;
                console.log('🦶 Personaggio ancorato al pavimento. Y =', targetY.toFixed(3));
            } else {
                // Frame successivi: lerp rapido per scalini fluidi
                character.position.y += (targetY - character.position.y) * 20 * delta;
            }
        }

        raycaster.far = Infinity; // reset

        // ── CLAMPING MATEMATICO (confine invalicabile) ───────────────────────
        // Margine di 0.4: mezzo "corpo" del personaggio dentro la parete
        character.position.x = Math.max(ROOM_LIMITS.minX + 0.4, Math.min(ROOM_LIMITS.maxX - 0.4, character.position.x));
        character.position.z = Math.max(ROOM_LIMITS.minZ + 0.4, Math.min(ROOM_LIMITS.maxZ - 0.4, character.position.z));

        // ── TRANSIZIONE ANIMAZIONI ───────────────────────────────────────────
        if (isMoving && walkAction && currentAction !== walkAction) {
            if (currentAction) currentAction.fadeOut(0.2);
            walkAction.reset().fadeIn(0.2).play();
            currentAction = walkAction;
        } else if (!isMoving && idleAction && currentAction !== idleAction) {
            if (currentAction) currentAction.fadeOut(0.2);
            idleAction.reset().fadeIn(0.2).play();
            currentAction = idleAction;
        }

        // Camera sempre puntata sul petto del personaggio
        controls.target.set(character.position.x, character.position.y + 1, character.position.z);
    }

    controls.update();
    renderer.render(scene, camera);
}

animate();
