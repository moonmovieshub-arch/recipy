const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});

const db = admin.firestore();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

// ============ MIDDLEWARE ============
const verifyAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.email !== process.env.ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.admin = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ============ PUBLIC ROUTES ============

// Get all articles (with pagination)
app.get('/api/articles', async (req, res) => {
  try {
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
    res.status(500).json({ error: error.message });
  }
});

// Get single article by slug
app.get('/api/article/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
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
    res.status(500).json({ error: error.message });
  }
});

// Get all affiliate products
app.get('/api/products', async (req, res) => {
  try {
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
    res.status(500).json({ error: error.message });
  }
});

// Check subscription status
app.post('/api/check-subscription', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    
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
    res.status(500).json({ error: error.message });
  }
});

// Get ebooks (only if subscription active)
app.post('/api/ebooks', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    
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
    res.status(500).json({ error: error.message });
  }
});

// Subscribe user
app.post('/api/subscribe', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    
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
    res.status(500).json({ error: error.message });
  }
});

// Admin login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (email !== process.env.ADMIN_EMAIL) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const isValid = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, email });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ ADMIN ROUTES (Protected) ============

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
    
    const docRef = await db.collection('articles').add(article);
    res.json({ id: docRef.id, ...article });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update article
app.put('/api/admin/articles/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, slug, imageUrl, shortDesc, fullContent } = req.body;
    
    await db.collection('articles').doc(id).update({
      title, slug, imageUrl, shortDesc, fullContent,
      updatedAt: new Date().toISOString()
    });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete article
app.delete('/api/admin/articles/:id', verifyAdmin, async (req, res) => {
  try {
    await db.collection('articles').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
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
    
    const docRef = await db.collection('ebooks').add(ebook);
    res.json({ id: docRef.id, ...ebook });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete ebook
app.delete('/api/admin/ebooks/:id', verifyAdmin, async (req, res) => {
  try {
    await db.collection('ebooks').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
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
    
    const docRef = await db.collection('affiliateLinks').add(product);
    res.json({ id: docRef.id, ...product });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete product
app.delete('/api/admin/products/:id', verifyAdmin, async (req, res) => {
  try {
    await db.collection('affiliateLinks').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all subscribers
app.get('/api/admin/subscribers', verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('subscribers').orderBy('subscribedAt', 'desc').get();
    const subscribers = [];
    snapshot.forEach(doc => {
      subscribers.push({ id: doc.id, ...doc.data() });
    });
    res.json(subscribers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update subscriber status
app.put('/api/admin/subscribers/:id', verifyAdmin, async (req, res) => {
  try {
    const { isActive, expiryDate } = req.body;
    const updateData = { isActive };
    
    if (isActive && expiryDate) {
      updateData.expiryDate = expiryDate;
    } else if (!isActive) {
      updateData.expiryDate = null;
    }
    
    await db.collection('subscribers').doc(req.params.id).update(updateData);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete subscriber
app.delete('/api/admin/subscribers/:id', verifyAdmin, async (req, res) => {
  try {
    await db.collection('subscribers').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
