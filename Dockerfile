# Use a lightweight Python base image
FROM python:3.9-slim

# Set working directory inside the container
WORKDIR /app

# Copy dependency definition first (for efficient caching)
COPY requirements.txt .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code
COPY . .

# Expose port 5000
EXPOSE 5000

# Command to run the app using Gunicorn
# -w 4: Use 4 worker processes for concurrency
# -b 0.0.0.0:5000: Bind to all network interfaces inside container
CMD ["gunicorn", "-w", "4", "-b", "0.0.0.0:5000", "app:app"]