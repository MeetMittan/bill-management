const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: [true, 'Category name is required'],
    trim: true,
    maxlength: 60
  },
  color: {
    type: String,
    default: '#3b82f6' // Default blue
  },
  icon: {
    type: String,
    default: 'tag'
  },
  description: {
    type: String,
    default: ''
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Ensure a user cannot have duplicate category names
categorySchema.index({ user: 1, name: 1 }, { unique: true });

// Static helper to initialize default categories for a new user
categorySchema.statics.seedDefaultsForUser = async function(userId) {
  const defaultCategories = [
    { name: 'Hardware', color: '#6366f1', icon: 'server', description: 'Computers, monitors, servers and peripherals' },
    { name: 'Software & Cloud', color: '#06b6d4', icon: 'cloud', description: 'SaaS subscriptions, hosting, domain and dev tools' },
    { name: 'Office Supplies', color: '#10b981', icon: 'briefcase', description: 'Stationery, furniture and daily workplace essentials' },
    { name: 'Travel & Lodging', color: '#f59e0b', icon: 'plane', description: 'Flights, trains, cabs, hotels and per diems' },
    { name: 'Utilities & Bills', color: '#8b5cf6', icon: 'zap', description: 'Electricity, internet, phone and water' },
    { name: 'Legal & Professional', color: '#ec4899', icon: 'shield', description: 'Legal fees, audit charges, compliance and consulting' },
    { name: 'Meals & Entertainment', color: '#f97316', icon: 'coffee', description: 'Client dinners, team lunches and refreshments' },
    { name: 'General / Miscellaneous', color: '#64748b', icon: 'tag', description: 'Uncategorized or miscellaneous expenditures' }
  ];

  const existing = await this.find({ user: userId });
  if (existing.length === 0) {
    const docs = defaultCategories.map(cat => ({ ...cat, user: userId }));
    await this.insertMany(docs);
  }
};

module.exports = mongoose.model('Category', categorySchema);

