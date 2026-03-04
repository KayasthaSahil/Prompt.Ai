import os
from flask import Flask, render_template, request, redirect, url_for, flash
from pymongo import MongoClient, TEXT
from bson.objectid import ObjectId
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv('SECRET_KEY')

# Database Setup
client = MongoClient(os.getenv('MONGO_URI'))
db = client.get_database()
prompts_collection = db.prompts

# Ensure Text Index for Search (Run once on startup)
prompts_collection.create_index([
    ('title', TEXT), 
    ('content', TEXT), 
    ('tags', TEXT)
])

@app.route('/')
def index():
    """Display all prompts."""
    all_prompts = list(prompts_collection.find().sort("created_at", -1))
    return render_template('index.html', prompts=all_prompts)

@app.route('/search')
def search():
    """Handle search queries."""
    query = request.args.get('q')
    if query:
        # Perform text search
        results = list(prompts_collection.find(
            {"$text": {"$search": query}},
            {"score": {"$meta": "textScore"}}
        ).sort([("score", {"$meta": "textScore"})]))
    else:
        results = list(prompts_collection.find().sort("created_at", -1))
    
    return render_template('index.html', prompts=results)

@app.route('/create', methods=['POST'])
def create_prompt():
    """Handle creation of a new prompt."""
    title = request.form.get('title')
    # Get HTML content from hidden input (populated by Quill)
    content = request.form.get('content') 
    tags = request.form.get('tags', '').split(',')
    
    tags = [tag.strip() for tag in tags if tag.strip()]

    new_prompt = {
        "title": title,
        "content": content, # Now stores HTML string
        "tags": tags,
        "folder": "General",
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow()
    }
    
    prompts_collection.insert_one(new_prompt)
    flash('Prompt created successfully!', 'success')
    return redirect(url_for('index'))

@app.route('/delete/<prompt_id>')
def delete_prompt(prompt_id):
    prompts_collection.delete_one({'_id': ObjectId(prompt_id)})
    flash('Prompt deleted.', 'info')
    return redirect(url_for('index'))

if __name__ == '__main__':
    app.run(debug=True, port=5000)