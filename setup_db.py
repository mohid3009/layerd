import psycopg2

conn = psycopg2.connect("postgresql://postgres:postgres@localhost:5432/postgres")
conn.autocommit = True
cur = conn.cursor()
cur.execute("SELECT 1 FROM pg_database WHERE datname = 'layerd'")
if not cur.fetchone():
    cur.execute("CREATE DATABASE layerd")
    print("created database layerd")
conn.close()

conn = psycopg2.connect("postgresql://postgres:postgres@localhost:5432/layerd")
conn.autocommit = True
cur = conn.cursor()
cur.execute("CREATE EXTENSION IF NOT EXISTS postgis")
cur.execute("SELECT postgis_version()")
print("postgis:", cur.fetchone()[0])
conn.close()
