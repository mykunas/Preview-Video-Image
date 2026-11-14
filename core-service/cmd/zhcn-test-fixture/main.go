// This utility only seeds the disposable UI-test database passed explicitly.
package main

import (
 "database/sql"
 "fmt"
 "os"
 _ "modernc.org/sqlite"
)
func main(){
 if len(os.Args)!=2{panic("pass the disposable test database path")}
 db,err:=sql.Open("sqlite",os.Args[1]);if err!=nil{panic(err)};defer db.Close()
 for i:=1;i<=18;i++{_,err=db.Exec("INSERT INTO downloads(group_id,group_name,message_id,file_name,file_size,file_type,file_path) VALUES('-100test','移植验证',?,?,1,'video',?)",i,fmt.Sprintf("测试视频%d.mp4",i),fmt.Sprintf("demo-%d.mp4",i));if err!=nil{panic(err)}}
 fmt.Println("Seeded 18 disposable videos")
}
