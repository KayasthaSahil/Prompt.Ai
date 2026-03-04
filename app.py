import os
import json
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify, Response
from pymongo import MongoClient, TEXT
from bson.objectid import ObjectId
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv('SECRET_KEY', 'default_secret')

# Database Setup
client = MongoClient(os.getenv('MONGO_URI', 'mongodb://localhost:27017/'))
db = client.get_database()
prompts_collection = db.prompts

# Ensure Text Index for Search (Run once on startup)
try:
    prompts_collection.create_index([
        ('title', TEXT), 
        ('content', TEXT), 
        ('tags', TEXT),
        ('folder', TEXT)
    ])
except Exception:
    pass

# Utility to serialize ObjectId
def serialize_doc(doc):
    doc['_id'] = str(doc['_id'])
    doc['created_at'] = doc.get('created_at', datetime.utcnow()).isoformat()
    doc['updated_at'] = doc.get('updated_at', datetime.utcnow()).isoformat()
    return doc

@app.route('/')
def index():
    """Display all prompts."""
    all_prompts = list(prompts_collection.find().sort([("is_favorite", -1), ("created_at", -1)]))
    serialized_prompts = [serialize_doc(p) for p in all_prompts]
    folders = prompts_collection.distinct("folder")
    folders = [f for f in folders if f and f.strip()]
    if "General" not in folders:
        folders.append("General")
    return render_template('index.html', prompts=serialized_prompts, folders=sorted(folders), current_folder="All")

@app.route('/folder/<path:folder_name>')
def by_folder(folder_name):
    """Display prompts by folder."""
    all_prompts = list(prompts_collection.find({"folder": folder_name}).sort([("is_favorite", -1), ("created_at", -1)]))
    serialized_prompts = [serialize_doc(p) for p in all_prompts]
    folders = prompts_collection.distinct("folder")
    folders = [f for f in folders if f and f.strip()]
    if "General" not in folders:
        folders.append("General")
    if folder_name not in folders:
        folders.append(folder_name)
    return render_template('index.html', prompts=serialized_prompts, folders=sorted(folders), current_folder=folder_name)

@app.route('/api/search')
def api_search():
    """Handle AJAX search queries."""
    query = request.args.get('q')
    folder = request.args.get('folder', 'All')
    
    match_query = {}
    if folder != "All":
        match_query["folder"] = folder

    if query:
        match_query["$text"] = {"$search": query}
        results = list(prompts_collection.find(
            match_query,
            {"score": {"$meta": "textScore"}}
        ).sort([("score", {"$meta": "textScore"})]))
    else:
        results = list(prompts_collection.find(match_query).sort([("is_favorite", -1), ("created_at", -1)]))
        
    return jsonify([serialize_doc(r) for r in results])

@app.route('/create', methods=['POST'])
def create_prompt():
    """Handle creation of a new prompt."""
    title = request.form.get('title')
    content = request.form.get('content') 
    tags = request.form.get('tags', '').split(',')
    folder = request.form.get('folder', 'General')
    if not folder.strip():
        folder = 'General'
        
    tags = [tag.strip() for tag in tags if tag.strip()]

    new_prompt = {
        "title": title,
        "content": content,
        "tags": tags,
        "folder": folder.strip(),
        "is_favorite": False,
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow()
    }
    
    prompts_collection.insert_one(new_prompt)
    flash('Prompt created successfully!', 'success')
    return redirect(url_for('index'))

@app.route('/edit/<prompt_id>', methods=['POST'])
def edit_prompt(prompt_id):
    """Handle editing of an existing prompt."""
    title = request.form.get('title')
    content = request.form.get('content') 
    tags = request.form.get('tags', '').split(',')
    folder = request.form.get('folder', 'General')
    
    if not folder.strip():
        folder = 'General'
        
    tags = [tag.strip() for tag in tags if tag.strip()]

    update_data = {
        "title": title,
        "content": content,
        "tags": tags,
        "folder": folder.strip(),
        "updated_at": datetime.utcnow()
    }
    
    prompts_collection.update_one({'_id': ObjectId(prompt_id)}, {'$set': update_data})
    
    if request.headers.get('Accept') == 'application/json':
        return jsonify({"success": True})
        
    flash('Prompt updated successfully!', 'success')
    return redirect(request.referrer or url_for('index'))

@app.route('/toggle_favorite/<prompt_id>', methods=['POST'])
def toggle_favorite(prompt_id):
    prompt = prompts_collection.find_one({'_id': ObjectId(prompt_id)})
    if prompt:
        new_status = not prompt.get('is_favorite', False)
        prompts_collection.update_one({'_id': ObjectId(prompt_id)}, {'$set': {'is_favorite': new_status}})
        return jsonify({"success": True, "is_favorite": new_status})
    return jsonify({"success": False, "error": "Not found"}), 404

@app.route('/delete/<prompt_id>', methods=['POST', 'GET'])
def delete_prompt(prompt_id):
    prompts_collection.delete_one({'_id': ObjectId(prompt_id)})
    if request.method == 'POST' or request.headers.get('Accept') == 'application/json':
        return jsonify({"success": True})
    flash('Prompt deleted.', 'info')
    return redirect(request.referrer or url_for('index'))

@app.route('/export')
def export_data():
    prompts = list(prompts_collection.find({}, {'_id': 0}))
    for p in prompts:
        if 'created_at' in p:
            p['created_at'] = p['created_at'].isoformat()
        if 'updated_at' in p:
            p['updated_at'] = p['updated_at'].isoformat()
    return Response(
        json.dumps(prompts, indent=2),
        mimetype='application/json',
        headers={'Content-Disposition': 'attachment;filename=prompts_backup.json'}
    )

@app.route('/import', methods=['POST'])
def import_data():
    if 'file' not in request.files:
        flash('No file part', 'error')
        return redirect(url_for('index'))
    file = request.files['file']
    if file.filename == '':
        flash('No selected file', 'error')
        return redirect(url_for('index'))
    
    if file:
        try:
            data = json.load(file)
            for item in data:
                if 'title' in item and 'content' in item:
                    item['created_at'] = datetime.utcnow()
                    item['updated_at'] = datetime.utcnow()
                    item['is_favorite'] = item.get('is_favorite', False)
                    item['folder'] = item.get('folder', 'General')
                    if '_id' in item:
                        del item['_id']
                    prompts_collection.insert_one(item)
            flash('Data imported successfully!', 'success')
        except Exception as e:
            flash(f'Error importing data: {str(e)}', 'error')
    return redirect(url_for('index'))

if __name__ == '__main__':
    app.run(debug=True, port=5000, host="0.0.0.0")