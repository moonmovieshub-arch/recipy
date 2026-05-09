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
        const demoData = {
            subscribers: [],
            articles: [],
            affiliateLinks: [],
            ebooks: [],
            users: []
        };
        
        db = {
            collection: (name) => ({
                add: async (data) => {
                    console.log(`📝 Demo: Added to ${name}:`, data);
                    const id = Date.now().toString();
                    if (!demoData[name]) demoData[name] = [];
                    demoData[name].push({ id, ...data });
                    return { id };
                },
                get: async () => ({
                    empty: demoData[name]?.length === 0,
                    forEach: (callback) => demoData[name]?.forEach(doc => callback({ data: () => doc, id: doc.id })),
                    docs: demoData[name]?.map(doc => ({ data: () => doc, id: doc.id })) || []
                }),
                where: (field, op, value) => ({
                    limit: () => ({
                        get: async () => ({
                            empty: !demoData[name]?.some(d => d[field] === value),
                            forEach: (callback) => demoData[name]?.filter(d => d[field] === value).forEach(doc => callback({ data: () => doc, id: doc.id }))
                        })
                    })
                }),
                doc: (id) => ({
                    update: async (data) => {
                        console.log(`📝 Demo: Updated ${name}/${id}:`, data);
                        const index = demoData[name]?.findIndex(d => d.id === id);
                        if (index !== -1) demoData[name][index] = { ...demoData[name][index], ...data };
                    },
                    delete: async () => {
                        console.log(`📝 Demo: Deleted ${name}/${id}`);
                        const index = demoData[name]?.findIndex(d => d.id === id);
                        if (index !== -1) demoData[name].splice(index, 1);
                    }
                }),
                orderBy: () => ({
                    get: async () => ({
                        empty: demoData[name]?.length === 0,
                        forEach: (callback) => demoData[name]?.forEach(doc => callback({ data: () => doc, id: doc.id })),
                        docs: demoData[name]?.map(doc => ({ data: () => doc, id: doc.id })) || []
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

// USER SIGNUP
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
            const hashedPassword = await bcrypt.hash(password, 10);
            const usersRef = db.collection('users');
            await usersRef.add({
                name, email, password: hashedPassword,
                createdAt: new Date().toISOString()
            });
            
            await db.collection('subscribers').add({
                email, name, isActive: false,
                subscribedAt: new Date().toISOString()
            });
            
            return res.json({ 
                success: true, 
                message: 'Demo mode - Account created successfully! Please login.'
            });
        }
        
        try {
            const existingUser = await auth.getUserByEmail(email);
            if (existingUser) {
                return res.status(400).json({ error: 'User already exists with this email' });
            }
        } catch (error) {
            // User doesn't exist, continue
        }
        
        const userRecord = await auth.createUser({
            email: email,
            password: password,
            displayName: name
        });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await db.collection('users').doc(userRecord.uid).set({
            name: name,
            email: email,
            password: hashedPassword,
            createdAt: new Date().toISOString(),
            uid: userRecord.uid
        });
        
        await db.collection('subscribers').add({
            email: email,
            name: name,
            isActive: false,
            subscribedAt: new Date().toISOString()
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

// USER LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        
        if (!isFirebaseInitialized) {
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
            
            const isValid = await bcrypt.compare(password, user.password);
            if (!isValid) {
                return res.status(401).json({ error: 'Invalid email or password' });
            }
            
            const token = jwt.sign({ email: user.email, name: user.name, uid: userId }, JWT_SECRET, { expiresIn: '7d' });
            
            return res.json({ success: true, token, email: user.email, name: user.name });
        }
        
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
        
        const isValid = await bcrypt.compare(password, user.password);
        
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
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

// Get all articles (with category)
app.get('/api/articles', async (req, res) => {
    try {
        if (!isFirebaseInitialized) {
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
                    category: data.category || 'all',
                    createdAt: data.createdAt
                });
            });
            if (articles.length === 0) {
                return res.json([
                    {
                        id: '1',
                        title: 'Creamy Garlic Parmesan Pasta',
                        slug: 'creamy-garlic-parmesan-pasta',
                        imageUrl: 'https://images.unsplash.com/photo-1645112411344-0f6e5e5b7f3e?w=500',
                        shortDesc: 'A rich and creamy pasta dish loaded with garlic and parmesan cheese.',
                        category: 'dinner',
                        createdAt: new Date().toISOString()
                    },
                    {
                        id: '2',
                        title: 'Homemade Margherita Pizza',
                        slug: 'homemade-margherita-pizza',
                        imageUrl: 'https://images.unsplash.com/photo-1604382355076-af4b0eb60143?w=500',
                        shortDesc: 'Classic Italian pizza with fresh basil, mozzarella, and tomato sauce.',
                        category: 'lunch',
                        createdAt: new Date().toISOString()
                    },
                    {
                        id: '3',
                        title: 'Fluffy Pancakes',
                        slug: 'fluffy-pancakes',
                        imageUrl: 'https://images.unsplash.com/photo-1575853121743-60c24f0a7502?w=500',
                        shortDesc: 'Light and fluffy pancakes perfect for breakfast.',
                        category: 'breakfast',
                        createdAt: new Date().toISOString()
                    },
                    {
                        id: '4',
                        title: 'Chocolate Lava Cake',
                        slug: 'chocolate-lava-cake',
                        imageUrl: 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=500',
                        shortDesc: 'Decadent chocolate cake with a gooey molten center.',
                        category: 'dessert',
                        createdAt: new Date().toISOString()
                    }
                ]);
            }
            return res.json(articles);
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
                category: data.category || 'all',
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
            const articlesRef = db.collection('articles');
            const snapshot = await articlesRef.where('slug', '==', slug).limit(1).get();
            
            if (!snapshot.empty) {
                let article = null;
                snapshot.forEach(doc => {
                    article = { id: doc.id, ...doc.data() };
                });
                if (article) return res.json(article);
            }
            
            const demoArticles = {
                'creamy-garlic-parmesan-pasta': {
                    id: '1',
                    title: 'Creamy Garlic Parmesan Pasta',
                    slug: 'creamy-garlic-parmesan-pasta',
                    imageUrl: 'https://images.unsplash.com/photo-1645112411344-0f6e5e5b7f3e?w=800',
                    shortDesc: 'A rich and creamy pasta dish loaded with garlic and parmesan cheese.',
                    category: 'dinner',
                    fullContent: 'This creamy garlic parmesan pasta is the ultimate comfort food.\n\nIngredients:\n- 8 oz pasta\n- 4 cloves garlic\n- 1 cup heavy cream\n- 1/2 cup parmesan cheese\n\nInstructions:\n1. Cook pasta\n2. Sauté garlic\n3. Add cream\n4. Stir in parmesan\n5. Serve!',
                    createdAt: new Date().toISOString()
                },
                'homemade-margherita-pizza': {
                    id: '2',
                    title: 'Homemade Margherita Pizza',
                    slug: 'homemade-margherita-pizza',
                    imageUrl: 'https://images.unsplash.com/photo-1604382355076-af4b0eb60143?w=800',
                    shortDesc: 'Classic Italian pizza with fresh basil, mozzarella, and tomato sauce.',
                    category: 'lunch',
                    fullContent: 'Nothing beats a homemade Margherita pizza.\n\nIngredients:\n- Pizza dough\n- San Marzano tomatoes\n- Fresh mozzarella\n- Fresh basil\n\nInstructions:\n1. Preheat oven to 500°F\n2. Stretch dough\n3. Add toppings\n4. Bake until bubbly',
                    createdAt: new Date().toISOString()
                },
                'fluffy-pancakes': {
                    id: '3',
                    title: 'Fluffy Pancakes',
                    slug: 'fluffy-pancakes',
                    imageUrl: 'https://images.unsplash.com/photo-1575853121743-60c24f0a7502?w=800',
                    shortDesc: 'Light and fluffy pancakes perfect for breakfast.',
                    category: 'breakfast',
                    fullContent: 'Start your day with these delicious fluffy pancakes.\n\nIngredients:\n- 1 cup flour\n- 2 tbsp sugar\n- 1 tsp baking powder\n- 1 cup milk\n- 1 egg\n\nInstructions:\n1. Mix dry ingredients\n2. Add wet ingredients\n3. Cook on griddle\n4. Serve with maple syrup',
                    createdAt: new Date().toISOString()
                },
                'chocolate-lava-cake': {
                    id: '4',
                    title: 'Chocolate Lava Cake',
                    slug: 'chocolate-lava-cake',
                    imageUrl: 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=800',
                    shortDesc: 'Decadent chocolate cake with a gooey molten center.',
                    category: 'dessert',
                    fullContent: 'The ultimate dessert for chocolate lovers.\n\nIngredients:\n- 4 oz dark chocolate\n- 1/2 cup butter\n- 2 eggs\n- 1/4 cup sugar\n- 2 tbsp flour\n\nInstructions:\n1. Melt chocolate and butter\n2. Whisk eggs and sugar\n3. Combine all ingredients\n4. Bake for 12 minutes\n5. Serve immediately',
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
            const productsRef = db.collection('affiliateLinks');
            const snapshot = await productsRef.orderBy('createdAt', 'desc').get();
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
            if (products.length === 0) {
                return res.json([
                    {
                        id: '1',
                        name: 'Professional Chef Knife',
                        imageUrl: 'https://images.unsplash.com/photo-1593615694814-d4f0b9d0e7b8?w=300',
                        price: '$49.99',
                        description: 'High-carbon stainless steel chef knife with ergonomic handle.',
                        redirectUrl: 'https://amazon.com/demo'
                    }
                ]);
            }
            return res.json(products);
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

// Check subscription status - LIFETIME (no expiry)
app.post('/api/check-subscription', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }
        
        if (!isFirebaseInitialized) {
            const subscribersRef = db.collection('subscribers');
            const snapshot = await subscribersRef.where('email', '==', email).limit(1).get();
            
            if (snapshot.empty) {
                return res.json({ isActive: false, isLifetime: false });
            }
            
            let subscriber = null;
            snapshot.forEach(doc => {
                subscriber = { id: doc.id, ...doc.data() };
            });
            
            return res.json({ 
                isActive: subscriber.isActive === true,
                isLifetime: true
            });
        }
        
        const subscriberRef = db.collection('subscribers');
        const snapshot = await subscriberRef.where('email', '==', email).limit(1).get();
        
        if (snapshot.empty) {
            return res.json({ isActive: false, isLifetime: false });
        }
        
        let subscriber = null;
        snapshot.forEach(doc => {
            subscriber = { id: doc.id, ...doc.data() };
        });
        
        const isActive = subscriber.isActive === true;
        
        res.json({ 
            isActive: isActive,
            isLifetime: true,
            message: isActive ? "Active lifetime subscription" : "No active subscription"
        });
    } catch (error) {
        console.error('Error checking subscription:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get ebooks (requires active subscription)
app.post('/api/ebooks', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }
        
        if (!isFirebaseInitialized) {
            const subscribersRef = db.collection('subscribers');
            const subSnapshot = await subscribersRef.where('email', '==', email).limit(1).get();
            
            let isActive = false;
            if (!subSnapshot.empty) {
                subSnapshot.forEach(doc => {
                    isActive = doc.data().isActive === true;
                });
            }
            
            if (!isActive && email !== 'demo@example.com') {
                return res.status(403).json({ error: 'Active subscription required' });
            }
            
            const ebooksRef = db.collection('ebooks');
            const ebookSnapshot = await ebooksRef.orderBy('createdAt', 'desc').get();
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
            
            if (ebooks.length === 0) {
                return res.json([
                    {
                        id: '1',
                        name: 'The Ultimate Recipe Guide',
                        imageUrl: 'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=300',
                        pdfUrl: '#'
                    }
                ]);
            }
            return res.json(ebooks);
        }
        
        const subSnapshot = await db.collection('subscribers').where('email', '==', email).limit(1).get();
        if (subSnapshot.empty) {
            return res.status(403).json({ error: 'Subscription required' });
        }
        
        let subscriber = null;
        subSnapshot.forEach(doc => {
            subscriber = { id: doc.id, ...doc.data() };
        });
        
        if (!subscriber.isActive) {
            return res.status(403).json({ error: 'Active subscription required' });
        }
        
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

// Subscribe user (newsletter - not premium)
app.post('/api/subscribe', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }
        
        if (!isFirebaseInitialized) {
            const existing = await db.collection('subscribers').where('email', '==', email).get();
            if (!existing.empty) {
                return res.json({ message: 'Email already registered' });
            }
            
            await db.collection('subscribers').add({
                email: email,
                isActive: false,
                subscribedAt: new Date().toISOString()
            });
            
            return res.json({ success: true, message: 'Subscribed successfully! Contact admin for premium activation.' });
        }
        
        const existing = await db.collection('subscribers').where('email', '==', email).get();
        if (!existing.empty) {
            return res.json({ message: 'Email already registered' });
        }
        
        await db.collection('subscribers').add({
            email: email,
            isActive: false,
            subscribedAt: new Date().toISOString()
        });
        
        res.json({ success: true, message: 'Subscribed successfully! Contact admin for premium activation.' });
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

// Get all ebooks (admin)
app.get('/api/admin/ebooks', verifyAdmin, async (req, res) => {
    try {
        if (!isFirebaseInitialized) {
            const ebooksRef = db.collection('ebooks');
            const snapshot = await ebooksRef.orderBy('createdAt', 'desc').get();
            const ebooks = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                ebooks.push({
                    id: doc.id,
                    name: data.name,
                    imageUrl: data.imageUrl,
                    pdfUrl: data.pdfUrl,
                    createdAt: data.createdAt
                });
            });
            return res.json(ebooks);
        }
        
        const snapshot = await db.collection('ebooks').orderBy('createdAt', 'desc').get();
        const ebooks = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            ebooks.push({
                id: doc.id,
                name: data.name,
                imageUrl: data.imageUrl,
                pdfUrl: data.pdfUrl,
                createdAt: data.createdAt
            });
        });
        res.json(ebooks);
    } catch (error) {
        console.error('Error fetching ebooks:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add article (WITH CATEGORY)
app.post('/api/admin/articles', verifyAdmin, async (req, res) => {
    try {
        const { title, slug, imageUrl, shortDesc, fullContent, category } = req.body;
        
        if (!title || !slug || !imageUrl || !shortDesc || !fullContent) {
            return res.status(400).json({ error: 'All fields required' });
        }
        
        const article = {
            title,
            slug,
            imageUrl,
            shortDesc,
            fullContent,
            category: category || 'all',
            createdAt: new Date().toISOString()
        };
        
        if (!isFirebaseInitialized) {
            const docRef = await db.collection('articles').add(article);
            return res.json({ id: docRef.id, ...article });
        }
        
        const docRef = await db.collection('articles').add(article);
        res.json({ id: docRef.id, ...article });
    } catch (error) {
        console.error('Error adding article:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update article (WITH CATEGORY)
app.put('/api/admin/articles/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, slug, imageUrl, shortDesc, fullContent, category } = req.body;
        
        if (!isFirebaseInitialized) {
            await db.collection('articles').doc(id).update({
                title, slug, imageUrl, shortDesc, fullContent,
                category: category || 'all',
                updatedAt: new Date().toISOString()
            });
            return res.json({ success: true });
        }
        
        await db.collection('articles').doc(id).update({
            title, slug, imageUrl, shortDesc, fullContent,
            category: category || 'all',
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
            await db.collection('articles').doc(id).delete();
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
        
        if (!name || !imageUrl || !pdfUrl) {
            return res.status(400).json({ error: 'All fields required' });
        }
        
        const ebook = {
            name,
            imageUrl,
            pdfUrl,
            createdAt: new Date().toISOString()
        };
        
        if (!isFirebaseInitialized) {
            const docRef = await db.collection('ebooks').add(ebook);
            return res.json({ id: docRef.id, ...ebook });
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
            await db.collection('ebooks').doc(id).delete();
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
            const docRef = await db.collection('affiliateLinks').add(product);
            return res.json({ id: docRef.id, ...product });
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
            await db.collection('affiliateLinks').doc(id).delete();
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
            const snapshot = await db.collection('subscribers').orderBy('subscribedAt', 'desc').get();
            const subscribers = [];
            snapshot.forEach(doc => {
                subscribers.push({ id: doc.id, ...doc.data() });
            });
            return res.json(subscribers);
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

// Update subscriber status - LIFETIME (no expiry date)
app.put('/api/admin/subscribers/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body;
        
        const updateData = { 
            isActive: isActive === true,
            updatedAt: new Date().toISOString()
        };
        
        if (!isFirebaseInitialized) {
            await db.collection('subscribers').doc(id).update(updateData);
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
            await db.collection('subscribers').doc(id).delete();
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
            'GET /api/admin/ebooks',
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
