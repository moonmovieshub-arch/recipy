const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// Middleware
app.use(cors({
    origin: ['https://therecipenest.lovestoblog.com', 'http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Initialize Firebase Admin SDK
const serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};

// Check if we're in development mode (no Firebase)
let db = null;
let auth = null;
let isFirebaseInitialized = false;

try {
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        db = admin.firestore();
        auth = admin.auth();
        isFirebaseInitialized = true;
        console.log('✅ Firebase initialized successfully');
    } else {
        console.log('⚠️ Firebase credentials missing, running in demo mode');
        // Demo data store (in-memory for testing)
        db = {
            collection: (name) => ({
                add: async (data) => {
                    console.log(`📝 Demo: Added to ${name}:`, data);
                    return { id: Date.now().toString() };
                },
                get: async () => ({
                    empty: true,
                    forEach: () => {},
                    docs: []
                }),
                where: () => ({
                    limit: () => ({
                        get: async () => ({
                            empty: true,
                            forEach: () => {}
                        })
                    })
                }),
                doc: (id) => ({
                    update: async (data) => {
                        console.log(`📝 Demo: Updated ${name}/${id}:`, data);
                    },
                    delete: async () => {
                        console.log(`📝 Demo: Deleted ${name}/${id}`);
                    }
                }),
                orderBy: () => ({
                    get: async () => ({
                        empty: true,
                        forEach: () => {},
                        docs: []
                    })
                })
            })
        };
        auth = {
            createUser: async (data) => {
                console.log('📝 Demo: Creating user:', data);
                return { uid: 'demo-' + Date.now() };
            },
            getUserByEmail: async (email) => {
                throw new Error('User not found');
            }
        };
    }
} catch (error) {
    console.error('❌ Firebase initialization error:', error.message);
    isFirebaseInitialized = false;
}

const JWT_SECRET = process.env.JWT_SECRET || 'recipe-blog-secret-key-change-in-production-2026';

// ============ MIDDLEWARE ============
const verifyAdmin = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.email !== process.env.ADMIN_EMAIL) {
            return res.status(403).json({ error: 'Forbidden - Invalid admin credentials' });
        }
        req.admin = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};

// ============ PUBLIC ROUTES ============

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        firebase: isFirebaseInitialized,
        mode: isFirebaseInitialized ? 'production' : 'demo'
    });
});

// USER SIGNUP - NEW ENDPOINT
app.post('/api/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        
        if (!email || !password || !name) {
            return res.status(400).json({ error: 'All fields required (name, email, password)' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        
        if (!isFirebaseInitialized) {
            // Demo mode - store in memory/demo
            console.log(`Demo: Creating user ${email}`);
            return res.json({ 
                success: true, 
                message: 'Demo mode - Account created successfully! Please login.',
                uid: 'demo-' + Date.now()
            });
        }
        
        // Check if user already exists
        try {
            const existingUser = await auth.getUserByEmail(email);
            if (existingUser) {
                return res.status(400).json({ error: 'User already exists with this email' });
            }
        } catch (error) {
            // User doesn't exist, continue
        }
        
        // Create user in Firebase Authentication
        const userRecord = await auth.createUser({
            email: email,
            password: password,
            displayName: name
        });
        
        // Hash password for local storage (optional)
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Create user document in Firestore
        await db.collection('users').doc(userRecord.uid).set({
            name: name,
            email: email,
            password: hashedPassword,
            createdAt: new Date().toISOString(),
            uid: userRecord.uid
        });
        
        // Auto-add to subscribers (inactive by default, admin can activate)
        await db.collection('subscribers').add({
            email: email,
            name: name,
            isActive: false,
            subscribedAt: new Date().toISOString(),
            expiryDate: null,
            uid: userRecord.uid
        });
        
        console.log(`✅ User created: ${email} (${userRecord.uid})`);
        
        res.json({ 
            success: true, 
            message: 'Account created successfully! Please login.',
            uid: userRecord.uid
        });
        
    } catch (error) {
        console.error('Signup error:', error);
        res.status(400).json({ error: error.message });
    }
});

// USER LOGIN - NEW ENDPOINT
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        
        if (!isFirebaseInitialized) {
            // Demo mode - check demo credentials
            const users = JSON.parse(global.demoUsers || '[]');
            const user = users.find(u => u.email === email && u.password === password);
            if (user) {
                const token = jwt.sign({ email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
                return res.json({ success: true, token, email, name: user.name });
            } else if (email === 'demo@example.com' && password === 'demo123') {
                const token = jwt.sign({ email, name: 'Demo User' }, JWT_SECRET, { expiresIn: '7d' });
                return res.json({ success: true, token, email, name: 'Demo User' });
            }
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        // Find user in Firestore
        const usersRef = db.collection('users');
        const snapshot = await usersRef.where('email', '==', email).limit(1).get();
        
        if (snapshot.empty) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        let user = null;
        let userId = null;
        snapshot.forEach(doc => {
            user = doc.data();
            userId = doc.id;
        });
        
        // Verify password
        const isValid = await bcrypt.compare(password, user.password);
        
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        // Generate JWT token
        const token = jwt.sign(
            { email: user.email, name: user.name, uid: userId },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        res.json({
            success: true,
            token,
            email: user.email,
            name: user.name
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all articles
app.get('/api/articles', async (req, res) => {
    try {
        if (!isFirebaseInitialized) {
            // Return demo articles
            return res.json([
                {
                    id: '1',
                    title: 'Creamy Garlic Parmesan Pasta',
                    slug: 'creamy-garlic-parmesan-pasta',
                    imageUrl: 'https://images.unsplash.com/photo-1645112411344-0f6e5e5b7f3e?w=500',
                    shortDesc: 'A rich and creamy pasta dish loaded with garlic and parmesan cheese.',
                    createdAt: new Date().toISOString()
                },
                {
                    id: '2',
                    title: 'Homemade Margherita Pizza',
                    slug: 'homemade-margherita-pizza',
                    imageUrl: 'https://images.unsplash.com/photo-1604382355076-af4b0eb60143?w=500',
                    shortDesc: 'Classic Italian pizza with fresh basil, mozzarella, and tomato sauce.',
                    createdAt: new Date().toISOString()
                },
                {
                    id: '3',
                    title: 'Chocolate Lava Cake',
                    slug: 'chocolate-lava-cake',
                    imageUrl: 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=500',
                    shortDesc: 'Decadent chocolate cake with a gooey molten center.',
                    createdAt: new Date().toISOString()
                }
            ]);
        }
        
        const articlesRef = db.collection('articles');
        const snapshot = await articlesRef.orderBy('createdAt', 'desc').get();
        const articles = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            articles.push({
                id: doc.id,
                title: data.title,
                slug: data.slug,
                imageUrl: data.imageUrl,
                shortDesc: data.shortDesc,
                createdAt: data.createdAt
            });
        });
        res.json(articles);
    } catch (error) {
        console.error('Error fetching articles:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get single article by slug
app.get('/api/article/:slug', async (req, res) => {
    try {
        const slug = req.params.slug;
        
        if (!isFirebaseInitialized) {
            // Demo articles
            const demoArticles = {
                'creamy-garlic-parmesan-pasta': {
                    id: '1',
                    title: 'Creamy Garlic Parmesan Pasta',
                    slug: 'creamy-garlic-parmesan-pasta',
                    imageUrl: 'https://images.unsplash.com/photo-1645112411344-0f6e5e5b7f3e?w=800',
                    shortDesc: 'A rich and creamy pasta dish loaded with garlic and parmesan cheese.',
                    fullContent: 'This creamy garlic parmesan pasta is the ultimate comfort food. Made with simple ingredients, it comes together in just 20 minutes.\n\nIngredients:\n- 8 oz pasta\n- 4 cloves garlic\n- 1 cup heavy cream\n- 1/2 cup parmesan cheese\n\nInstructions:\n1. Cook pasta\n2. Sauté garlic\n3. Add cream\n4. Stir in parmesan\n5. Serve!',
                    createdAt: new Date().toISOString()
                },
                'homemade-margherita-pizza': {
                    id: '2',
                    title: 'Homemade Margherita Pizza',
                    slug: 'homemade-margherita-pizza',
                    imageUrl: 'https://images.unsplash.com/photo-1604382355076-af4b0eb60143?w=800',
                    shortDesc: 'Classic Italian pizza with fresh basil, mozzarella, and tomato sauce.',
                    fullContent: 'Nothing beats a homemade Margherita pizza.\n\nIngredients:\n- Pizza dough\n- San Marzano tomatoes\n- Fresh mozzarella\n- Fresh basil\n\nInstructions:\n1. Preheat oven to 500°F\n2. Stretch dough\n3. Add toppings\n4. Bake until bubbly',
                    createdAt: new Date().toISOString()
                }
            };
            
            const article = demoArticles[slug];
            if (!article) {
                return res.status(404).json({ error: 'Article not found' });
            }
            return res.json(article);
        }
        
        const articlesRef = db.collection('articles');
        const snapshot = await articlesRef.where('slug', '==', slug).limit(1).get();
        
        if (snapshot.empty) {
            return res.status(404).json({ error: 'Article not found' });
        }
        
        let article = null;
        snapshot.forEach(doc => {
            article = { id: doc.id, ...doc.data() };
        });
        res.json(article);
    } catch (error) {
        console.error('Error fetching article:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all affiliate products
app.get('/api/products', async (req, res) => {
    try {
        if (!isFirebaseInitialized) {
            return res.json([
                {
                    id: '1',
                    name: 'Professional Chef Knife',
                    imageUrl: 'https://images.unsplash.com/photo-1593615694814-d4f0b9d0e7b8?w=300',
                    price: '$49.99',
                    description: 'High-carbon stainless steel chef knife with ergonomic handle.',
                    redirectUrl: 'https://amazon.com/demo'
                },
                {
                    id: '2',
                    name: 'Cast Iron Skillet',
                    imageUrl: 'https://images.unsplash.com/photo-1584990347449-a85d9e7f9c0a?w=300',
                    price: '$39.99',
                    description: 'Pre-seasoned cast iron skillet for perfect searing.',
                    redirectUrl: 'https://amazon.com/demo'
                }
            ]);
        }
        
        const snapshot = await db.collection('affiliateLinks').orderBy('createdAt', 'desc').get();
        const products = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            products.push({
                id: doc.id,
                name: data.name,
                imageUrl: data.imageUrl,
                price: data.price,
                description: data.description,
                redirectUrl: data.redirectUrl
            });
        });
        res.json(products);
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ error: error.message });
    }
});

// Check subscription status
app.post('/api/check-subscription', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }
        
        if (!isFirebaseInitialized) {
            return res.json({ 
                isActive: email === 'demo@example.com',
                expiryDate: email === 'demo@example.com' ? new Date(Date.now() + 30*24*60*60*1000).toISOString() : null
            });
        }
        
        const subscriberRef = db.collection('subscribers');
        const snapshot = await subscriberRef.where('email', '==', email).limit(1).get();
        
        if (snapshot.empty) {
            return res.json({ isActive: false });
        }
        
        let subscriber = null;
        snapshot.forEach(doc => {
            subscriber = { id: doc.id, ...doc.data() };
        });
        
        const isActive = subscriber.isActive && new Date(subscriber.expiryDate) > new Date();
        res.json({ isActive, expiryDate: subscriber.expiryDate });
    } catch (error) {
        console.error('Error checking subscription:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get ebooks (requires subscription)
app.post('/api/ebooks', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }
        
        if (!isFirebaseInitialized) {
            if (email === 'demo@example.com') {
                return res.json([
                    {
                        id: '1',
                        name: 'The Ultimate Recipe Guide',
                        imageUrl: 'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=300',
                        pdfUrl: '#'
                    }
                ]);
            } else {
                return res.status(403).json({ error: 'Active subscription required' });
            }
        }
        
        // Check subscription first
        const subSnapshot = await db.collection('subscribers').where('email', '==', email).limit(1).get();
        if (subSnapshot.empty) {
            return res.status(403).json({ error: 'Subscription required' });
        }
        
        let subscriber = null;
        subSnapshot.forEach(doc => {
            subscriber = { id: doc.id, ...doc.data() };
        });
        
        if (!subscriber.isActive || new Date(subscriber.expiryDate) < new Date()) {
            return res.status(403).json({ error: 'Active subscription required' });
        }
        
        // Get ebooks
        const ebookSnapshot = await db.collection('ebooks').orderBy('createdAt', 'desc').get();
        const ebooks = [];
        ebookSnapshot.forEach(doc => {
            const data = doc.data();
            ebooks.push({
                id: doc.id,
                name: data.name,
                imageUrl: data.imageUrl,
                pdfUrl: data.pdfUrl
            });
        });
        res.json(ebooks);
    } catch (error) {
        console.error('Error fetching ebooks:', error);
        res.status(500).json({ error: error.message });
    }
});

// Subscribe user (newsletter)
app.post('/api/subscribe', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }
        
        if (!isFirebaseInitialized) {
            console.log(`Demo: Subscribed ${email}`);
            return res.json({ success: true, message: 'Subscribed successfully! Contact admin for activation.' });
        }
        
        // Check if already exists
        const existing = await db.collection('subscribers').where('email', '==', email).get();
        if (!existing.empty) {
            return res.json({ message: 'Email already registered' });
        }
        
        await db.collection('subscribers').add({
            email: email,
            isActive: false,
            subscribedAt: new Date().toISOString(),
            expiryDate: null
        });
        
        res.json({ success: true, message: 'Subscribed successfully! Contact admin for activation.' });
    } catch (error) {
        console.error('Error subscribing:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN LOGIN ROUTE ============
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        console.log('Admin login attempt:', { email, hasPassword: !!password });
        
        if (email !== process.env.ADMIN_EMAIL) {
            console.log('Admin login failed: Invalid email');
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        const adminPassword = process.env.ADMIN_PASSWORD;
        
        if (!adminPassword) {
            console.log('Admin login failed: No ADMIN_PASSWORD in environment');
            return res.status(500).json({ error: 'Server configuration error - Missing password' });
        }
        
        const isValid = (password === adminPassword);
        
        if (!isValid) {
            console.log('Admin login failed: Invalid password');
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        const token = jwt.sign(
            { email, role: 'admin' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        console.log('Admin login successful:', email);
        res.json({ 
            success: true,
            token, 
            email,
            message: 'Login successful'
        });
    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN ROUTES (Protected) ============

// Verify admin token
app.get('/api/admin/verify', verifyAdmin, async (req, res) => {
    res.json({ valid: true, email: req.admin.email });
});

// Add article
app.post('/api/admin/articles', verifyAdmin, async (req, res) => {
    try {
        const { title, slug, imageUrl, shortDesc, fullContent } = req.body;
        
        if (!title || !slug || !imageUrl || !shortDesc || !fullContent) {
            return res.status(400).json({ error: 'All fields required' });
        }
        
        const article = {
            title,
            slug,
            imageUrl,
            shortDesc,
            fullContent,
            createdAt: new Date().toISOString()
        };
        
        if (!isFirebaseInitialized) {
            console.log('Demo: Article added:', article);
            return res.json({ id: Date.now().toString(), ...article });
        }
        
        const docRef = await db.collection('articles').add(article);
        res.json({ id: docRef.id, ...article });
    } catch (error) {
        console.error('Error adding article:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update article
app.put('/api/admin/articles/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, slug, imageUrl, shortDesc, fullContent } = req.body;
        
        if (!isFirebaseInitialized) {
            console.log('Demo: Article updated:', { id, title, slug });
            return res.json({ success: true });
        }
        
        await db.collection('articles').doc(id).update({
            title, slug, imageUrl, shortDesc, fullContent,
            updatedAt: new Date().toISOString()
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating article:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete article
app.delete('/api/admin/articles/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        if (!isFirebaseInitialized) {
            console.log('Demo: Article deleted:', id);
            return res.json({ success: true });
        }
        
        await db.collection('articles').doc(id).delete();
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting article:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add ebook
app.post('/api/admin/ebooks', verifyAdmin, async (req, res) => {
    try {
        const { name, imageUrl, pdfUrl } = req.body;
        
        const ebook = {
            name,
            imageUrl,
            pdfUrl,
            createdAt: new Date().toISOString()
        };
        
        if (!isFirebaseInitialized) {
            console.log('Demo: Ebook added:', ebook);
            return res.json({ id: Date.now().toString(), ...ebook });
        }
        
        const docRef = await db.collection('ebooks').add(ebook);
        res.json({ id: docRef.id, ...ebook });
    } catch (error) {
        console.error('Error adding ebook:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete ebook
app.delete('/api/admin/ebooks/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        if (!isFirebaseInitialized) {
            console.log('Demo: Ebook deleted:', id);
            return res.json({ success: true });
        }
        
        await db.collection('ebooks').doc(id).delete();
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting ebook:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add affiliate product
app.post('/api/admin/products', verifyAdmin, async (req, res) => {
    try {
        const { name, imageUrl, price, description, redirectUrl } = req.body;
        
        const product = {
            name,
            imageUrl,
            price,
            description,
            redirectUrl,
            createdAt: new Date().toISOString()
        };
        
        if (!isFirebaseInitialized) {
            console.log('Demo: Product added:', product);
            return res.json({ id: Date.now().toString(), ...product });
        }
        
        const docRef = await db.collection('affiliateLinks').add(product);
        res.json({ id: docRef.id, ...product });
    } catch (error) {
        console.error('Error adding product:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete product
app.delete('/api/admin/products/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        if (!isFirebaseInitialized) {
            console.log('Demo: Product deleted:', id);
            return res.json({ success: true });
        }
        
        await db.collection('affiliateLinks').doc(id).delete();
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all subscribers
app.get('/api/admin/subscribers', verifyAdmin, async (req, res) => {
    try {
        if (!isFirebaseInitialized) {
            return res.json([
                { id: '1', email: 'demo@example.com', isActive: true, subscribedAt: new Date().toISOString(), expiryDate: new Date(Date.now() + 30*24*60*60*1000).toISOString() }
            ]);
        }
        
        const snapshot = await db.collection('subscribers').orderBy('subscribedAt', 'desc').get();
        const subscribers = [];
        snapshot.forEach(doc => {
            subscribers.push({ id: doc.id, ...doc.data() });
        });
        res.json(subscribers);
    } catch (error) {
        console.error('Error fetching subscribers:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update subscriber status
app.put('/api/admin/subscribers/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive, expiryDate } = req.body;
        const updateData = { isActive };
        
        if (isActive && expiryDate) {
            updateData.expiryDate = expiryDate;
        } else if (!isActive) {
            updateData.expiryDate = null;
        }
        
        if (!isFirebaseInitialized) {
            console.log('Demo: Subscriber updated:', { id, updateData });
            return res.json({ success: true });
        }
        
        await db.collection('subscribers').doc(id).update(updateData);
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating subscriber:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete subscriber
app.delete('/api/admin/subscribers/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        if (!isFirebaseInitialized) {
            console.log('Demo: Subscriber deleted:', id);
            return res.json({ success: true });
        }
        
        await db.collection('subscribers').doc(id).delete();
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting subscriber:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ CATCH ALL ROUTE FOR DEBUGGING ============
app.all('/api/*', (req, res) => {
    console.log(`Route not found: ${req.method} ${req.url}`);
    res.status(404).json({ 
        error: 'API endpoint not found',
        method: req.method,
        url: req.url,
        availableEndpoints: [
            'POST /api/signup',
            'POST /api/login',
            'POST /api/admin/login',
            'GET /api/health',
            'GET /api/articles',
            'GET /api/article/:slug',
            'GET /api/products',
            'POST /api/check-subscription',
            'POST /api/ebooks',
            'POST /api/subscribe',
            'GET /api/admin/verify',
            'GET /api/admin/subscribers',
            'POST /api/admin/articles',
            'PUT /api/admin/articles/:id',
            'DELETE /api/admin/articles/:id',
            'POST /api/admin/ebooks',
            'DELETE /api/admin/ebooks/:id',
            'POST /api/admin/products',
            'DELETE /api/admin/products/:id',
            'PUT /api/admin/subscribers/:id',
            'DELETE /api/admin/subscribers/:id'
        ]
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🔐 Admin login: POST http://localhost:${PORT}/api/admin/login`);
    console.log(`📝 User signup: POST http://localhost:${PORT}/api/signup`);
    console.log(`🔑 User login: POST http://localhost:${PORT}/api/login`);
});
