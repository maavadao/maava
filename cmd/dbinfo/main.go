package main

import (
	"database/sql"
	"fmt"
	"log"
	"os"

	"github.com/joho/godotenv"
	_ "github.com/lib/pq"
)

func main() {
	_ = godotenv.Load()
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL not set")
	}

	conn, err := sql.Open("postgres", dbURL)
	if err != nil {
		log.Fatalf("Open: %v", err)
	}
	defer conn.Close()

	if err := conn.Ping(); err != nil {
		log.Fatalf("Ping: %v", err)
	}
	fmt.Println("=== Connected to PostgreSQL ===")

	// List all tables in public schema
	rows, err := conn.Query(`
		SELECT table_name 
		FROM information_schema.tables 
		WHERE table_schema = 'public' 
		ORDER BY table_name
	`)
	if err != nil {
		log.Fatalf("Query tables: %v", err)
	}
	defer rows.Close()

	fmt.Println("\n=== Tables in public schema ===")
	var tables []string
	for rows.Next() {
		var name string
		rows.Scan(&name)
		fmt.Println(" -", name)
		tables = append(tables, name)
	}

	// For each table, show columns
	for _, table := range tables {
		fmt.Printf("\n=== Table: %s ===\n", table)
		cols, err := conn.Query(`
			SELECT column_name, data_type, is_nullable, column_default
			FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = $1
			ORDER BY ordinal_position
		`, table)
		if err != nil {
			fmt.Printf("  Error: %v\n", err)
			continue
		}
		for cols.Next() {
			var colName, dataType, nullable string
			var colDefault sql.NullString
			cols.Scan(&colName, &dataType, &nullable, &colDefault)
			def := ""
			if colDefault.Valid {
				def = " DEFAULT " + colDefault.String
			}
			fmt.Printf("  %-25s %-20s nullable=%s%s\n", colName, dataType, nullable, def)
		}
		cols.Close()
	}

	// Foreign keys
	fmt.Println("\n=== Foreign Key Relationships ===")
	fkRows, err := conn.Query(`
		SELECT
			tc.table_name AS from_table,
			kcu.column_name AS from_column,
			ccu.table_name AS to_table,
			ccu.column_name AS to_column
		FROM information_schema.table_constraints tc
		JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
		JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
		WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
		ORDER BY tc.table_name, kcu.column_name
	`)
	if err != nil {
		fmt.Printf("FK query error: %v\n", err)
	} else {
		defer fkRows.Close()
		for fkRows.Next() {
			var fromTable, fromCol, toTable, toCol string
			fkRows.Scan(&fromTable, &fromCol, &toTable, &toCol)
			fmt.Printf("  %s.%s -> %s.%s\n", fromTable, fromCol, toTable, toCol)
		}
	}

	// Indexes
	fmt.Println("\n=== Indexes ===")
	idxRows, err := conn.Query(`
		SELECT tablename, indexname, indexdef
		FROM pg_indexes
		WHERE schemaname = 'public'
		ORDER BY tablename, indexname
	`)
	if err != nil {
		fmt.Printf("Index query error: %v\n", err)
	} else {
		defer idxRows.Close()
		for idxRows.Next() {
			var tbl, idx, def string
			idxRows.Scan(&tbl, &idx, &def)
			fmt.Printf("  [%s] %s\n", tbl, def)
		}
	}

	// Row counts
	fmt.Println("\n=== Row Counts ===")
	for _, table := range tables {
		var count int
		conn.QueryRow(fmt.Sprintf("SELECT COUNT(*) FROM public.%q", table)).Scan(&count)
		fmt.Printf("  %-30s %d rows\n", table, count)
	}
}
