use babelfont::Font;
use typescript_type_def::write_definition_file;

fn main() {
    let ts_module = {
        let mut buf = Vec::new();
        write_definition_file::<_, Font>(&mut buf, Default::default()).unwrap();
        String::from_utf8(buf).unwrap()
    };
    println!("{}", ts_module);
}
